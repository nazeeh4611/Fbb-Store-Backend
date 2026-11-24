import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import UserModel from "../Model/UserModel.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../Utils/emailService.js";

// Falls back to the client id the storefront ships with, so Google sign-in
// always verifies the token audience even if the env var is forgotten.
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "418114033455-nu2odpsacsi4vb0sjrgsoebqcpfb9ai9.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const generateToken = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "30d" });
const generateGuestToken = (deviceId) =>
  jwt.sign({ deviceId, isGuest: true }, process.env.JWT_SECRET, { expiresIn: "60d" });
const generateOtp = () => crypto.randomInt(100000, 1000000).toString();
const normEmail = (email) => String(email || "").trim().toLowerCase();

const publicUser = (user) => ({
  id: user._id,
  _id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  emailVerified: user.emailVerified,
  isGuest: false,
});

const issueOtp = (user, purpose) => {
  const otp = generateOtp();
  user.otp = otp;
  user.otpExpiry = new Date(Date.now() + OTP_TTL_MS);
  user.otpAttempts = 0;
  user.otpPurpose = purpose;
  return otp;
};

/** Validates an OTP and counts failed attempts. Returns an error message or null. */
const checkOtp = async (user, otp, purpose) => {
  if (!user.otp || user.otpPurpose !== purpose) return "No active code. Please request a new one.";
  if (user.otpExpiry < new Date()) return "Code has expired. Please request a new one.";
  if ((user.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) return "Too many attempts. Please request a new code.";
  if (user.otp !== String(otp).trim()) {
    user.otpAttempts = (user.otpAttempts || 0) + 1;
    await user.save();
    return "Invalid code";
  }
  return null;
};

const clearOtp = (user) => {
  user.otp = null;
  user.otpExpiry = null;
  user.otpAttempts = 0;
  user.otpPurpose = null;
};

/**
 * When a guest signs in on the same device, carry their cart and wishlist over
 * so nothing they picked is lost.
 */
const mergeGuestData = async (req, user) => {
  const deviceId = req.headers["device-id"];
  if (!deviceId) return;
  try {
    const guest = await UserModel.findOne({ deviceId, isGuest: true });
    if (!guest || guest._id.equals(user._id)) return;

    for (const item of guest.cart) {
      const match = user.cart.find(
        (c) =>
          c.product.toString() === item.product.toString() &&
          (c.selectedColor || "") === (item.selectedColor || "") &&
          (c.selectedSize || "") === (item.selectedSize || "")
      );
      if (match) match.quantity = Math.max(match.quantity, item.quantity);
      else user.cart.push(item.toObject());
    }
    for (const w of guest.wishlist) {
      if (!user.wishlist.some((x) => x.product.toString() === w.product.toString())) {
        user.wishlist.push(w.toObject());
      }
    }
    guest.cart = [];
    guest.wishlist = [];
    await guest.save();
  } catch (err) {
    console.error("Guest merge failed:", err.message);
  }
};

const startSession = async (req, user) => {
  await mergeGuestData(req, user);
  const token = generateToken(user._id);
  user.sessionToken = token;
  user.lastActive = new Date();
  await user.save();
  return token;
};

export const register = async (req, res) => {
  try {
    const { username, phone, password } = req.body;
    const email = normEmail(req.body.email);
    const name = String(username || "").trim();
    const phoneNum = String(phone || "").trim();

    if (!name) return res.status(400).json({ success: false, message: "Name is required" });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: "Valid email is required" });
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const conditions = [{ email }];
    if (phoneNum) conditions.push({ phone: phoneNum });
    const existing = await UserModel.findOne({ $or: conditions, isGuest: false });

    let user;
    if (existing) {
      // An unverified account with this email can be re-registered (e.g. OTP never arrived).
      if (existing.email === email && !existing.emailVerified) {
        user = existing;
        user.name = name;
        if (phoneNum) user.phone = phoneNum;
        user.password = await bcrypt.hash(password, 10);
      } else {
        return res.status(400).json({ success: false, message: "An account with this email or phone already exists" });
      }
    } else {
      user = new UserModel({
        name,
        email,
        phone: phoneNum || undefined,
        password: await bcrypt.hash(password, 10),
        emailVerified: false,
        isGuest: false,
        deviceId: req.headers["device-id"] || undefined,
        sessionToken: null,
      });
    }

    const otp = issueOtp(user, "verify");
    await user.save();

    const emailSent = await sendOtpEmail(email, otp);
    if (!emailSent) {
      return res.status(502).json({
        success: false,
        message: "We couldn't send the verification email. Please try again.",
      });
    }

    res.status(201).json({
      success: true,
      message: "Registration successful. Please verify your email with the code we sent.",
      requiresVerification: true,
      email,
      user: publicUser(user),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "An account with this email or phone already exists" });
    }
    console.error("Registration error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const verifyEmail = async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const { otp } = req.body;

    const user = await UserModel.findOne({ email, isGuest: false });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.emailVerified) return res.status(400).json({ success: false, message: "Email already verified" });

    const otpError = await checkOtp(user, otp, "verify");
    if (otpError) return res.status(400).json({ success: false, message: otpError });

    user.emailVerified = true;
    clearOtp(user);
    const token = await startSession(req, user);

    res.status(200).json({
      success: true,
      message: "Email verified successfully",
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Email verification error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const resendOtp = async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const user = await UserModel.findOne({ email, isGuest: false });

    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.emailVerified) return res.status(400).json({ success: false, message: "Email already verified" });

    const otp = issueOtp(user, "verify");
    await user.save();

    if (!(await sendOtpEmail(email, otp))) {
      return res.status(502).json({ success: false, message: "Failed to resend code" });
    }
    res.status(200).json({ success: true, message: "Code resent successfully" });
  } catch (error) {
    console.error("Resend OTP error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const login = async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const user = await UserModel.findOne({ email, isGuest: false });
    if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    if (!user.emailVerified) {
      const otp = issueOtp(user, "verify");
      await user.save();
      await sendOtpEmail(email, otp);
      return res.status(403).json({
        success: false,
        requiresVerification: true,
        email,
        message: "Please verify your email. We've sent you a new code.",
      });
    }

    const token = await startSession(req, user);
    res.status(200).json({ success: true, message: "Login successful", token, user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ success: false, message: "Missing Google credential" });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified === false) {
      return res.status(401).json({ success: false, message: "Google account email is not verified" });
    }

    const email = normEmail(payload.email);
    let user = await UserModel.findOne({ email, isGuest: false });

    if (!user) {
      user = new UserModel({
        name: payload.name || email.split("@")[0],
        email,
        emailVerified: true,
        isGuest: false,
        deviceId: req.headers["device-id"] || undefined,
      });
    } else if (!user.emailVerified) {
      // Google has proven ownership of the address.
      user.emailVerified = true;
      clearOtp(user);
    }

    const token = await startSession(req, user);
    res.status(200).json({ success: true, message: "Authentication successful", token, user: publicUser(user) });
  } catch (error) {
    console.error("Google auth error:", error.message);
    res.status(401).json({ success: false, message: "Google authentication failed" });
  }
};

export const getGuestUser = async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || "").trim();
    if (!deviceId || deviceId.length > 100) {
      return res.status(400).json({ success: false, message: "Device ID is required" });
    }

    let user = await UserModel.findOne({ deviceId, isGuest: true });
    if (!user) {
      user = new UserModel({
        name: "Guest",
        isGuest: true,
        deviceId,
        preferences: { notifications: { email: false, whatsapp: false, sms: false } },
      });
    }

    // Reuse a still-valid guest token so several tabs don't log each other out.
    let token = user.sessionToken;
    try {
      if (!token) throw new Error("no token");
      jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      token = generateGuestToken(deviceId);
      user.sessionToken = token;
    }
    user.lastActive = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      message: "Guest session created",
      token,
      user: { id: user._id, name: user.name, isGuest: true, deviceId: user.deviceId },
    });
  } catch (error) {
    console.error("Guest user error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const logout = async (req, res) => {
  try {
    await UserModel.findByIdAndUpdate(req.userId, { sessionToken: null });
    res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getProfile = async (req, res) => {
  try {
    const user = await UserModel.findById(req.userId)
      .select("-password -otp -otpExpiry -otpAttempts -otpPurpose -sessionToken -__v")
      .lean();

    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.isGuest) return res.status(401).json({ success: false, message: "Not signed in" });

    res.status(200).json({ success: true, user });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const ADDRESS_KEYS = ["street", "city", "state", "country", "pincode", "phone"];
const pickAddress = (addr) => {
  if (!addr || typeof addr !== "object") return undefined;
  const out = {};
  for (const k of ADDRESS_KEYS) if (addr[k] !== undefined) out[k] = String(addr[k]).trim().slice(0, 200);
  return out;
};

export const updateProfile = async (req, res) => {
  try {
    if (req.isGuest) return res.status(401).json({ success: false, message: "Please sign in first" });

    // Only these fields may be changed by the user - never password, email, tokens, orders, etc.
    const { name, phone, address, preferences } = req.body;
    const update = {};
    if (typeof name === "string" && name.trim()) update.name = name.trim().slice(0, 100);
    if (typeof phone === "string") update.phone = phone.trim() || undefined;
    if (address?.shipping) update["address.shipping"] = pickAddress(address.shipping);
    if (address?.billing) update["address.billing"] = pickAddress(address.billing);
    if (preferences?.region && ["IN", "AE"].includes(preferences.region)) update["preferences.region"] = preferences.region;
    if (preferences?.currency && ["INR", "AED"].includes(preferences.currency)) {
      update["preferences.currency"] = preferences.currency;
    }
    if (preferences?.notifications && typeof preferences.notifications === "object") {
      for (const k of ["email", "whatsapp", "sms"]) {
        if (typeof preferences.notifications[k] === "boolean") {
          update[`preferences.notifications.${k}`] = preferences.notifications[k];
        }
      }
    }

    const user = await UserModel.findByIdAndUpdate(
      req.userId,
      { $set: update },
      { new: true, runValidators: true }
    ).select("-password -otp -otpExpiry -otpAttempts -otpPurpose -sessionToken -__v");

    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, message: "Profile updated successfully", user });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "This phone number is already in use" });
    }
    console.error("Update profile error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const verifyToken = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, message: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.userId) return res.status(401).json({ success: false, message: "Invalid token" });

    const user = await UserModel.findById(decoded.userId)
      .select("-password -otp -otpExpiry -otpAttempts -otpPurpose -__v")
      .lean();

    if (!user || user.sessionToken !== token) {
      return res.status(401).json({ success: false, message: "Session expired" });
    }
    delete user.sessionToken;
    res.status(200).json({ success: true, user });
  } catch {
    res.status(401).json({ success: false, message: "Invalid token" });
  }
};

/* ------------------------------------------------------ password reset */

export const forgotPassword = async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: "Valid email is required" });

    const user = await UserModel.findOne({ email, isGuest: false });
    // Always answer the same way so the endpoint can't be used to discover accounts.
    const genericResponse = {
      success: true,
      message: "If an account exists for this email, a reset code has been sent.",
    };
    if (!user) return res.status(200).json(genericResponse);

    const otp = issueOtp(user, "reset");
    await user.save();
    await sendPasswordResetEmail(email, otp);

    res.status(200).json(genericResponse);
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const { otp, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const user = await UserModel.findOne({ email, isGuest: false });
    if (!user) return res.status(400).json({ success: false, message: "Invalid or expired code" });

    const otpError = await checkOtp(user, otp, "reset");
    if (otpError) return res.status(400).json({ success: false, message: otpError });

    user.password = await bcrypt.hash(newPassword, 10);
    user.emailVerified = true; // they proved access to the inbox
    clearOtp(user);
    user.sessionToken = null; // sign out other sessions
    await user.save();

    res.status(200).json({ success: true, message: "Password reset successful. Please sign in." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
