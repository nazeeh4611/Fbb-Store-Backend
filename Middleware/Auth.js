import jwt from "jsonwebtoken";
import UserModel from "../Model/UserModel.js";

/** Accepts a registered-user token or a guest (device) token. */
export const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token || token === "null" || token === "undefined") {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let user;
    if (decoded.isGuest) {
      user = await UserModel.findOne({ deviceId: decoded.deviceId, isGuest: true });
      req.isGuest = true;
    } else if (decoded.userId) {
      user = await UserModel.findById(decoded.userId);
      req.isGuest = false;
    }

    if (!user) {
      return res.status(401).json({ success: false, message: "User not found" });
    }
    if (user.sessionToken !== token) {
      return res.status(401).json({ success: false, message: "Session expired" });
    }

    req.userId = user._id;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
};

/** Checkout requires a real account so we can email the receipt and show order history. */
export const requireRegisteredUser = (req, res, next) => {
  if (req.isGuest || req.user?.isGuest) {
    return res.status(401).json({
      success: false,
      requiresLogin: true,
      message: "Please sign in to place your order",
    });
  }
  next();
};
