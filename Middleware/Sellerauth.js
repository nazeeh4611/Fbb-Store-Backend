import jwt from "jsonwebtoken";
import SellerModel from "../Model/SellerModel.js";

export const sellerAuthMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role && decoded.role !== "seller") {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }

    const seller = await SellerModel.findById(decoded.userId).select("-password");
    if (!seller) {
      return res.status(401).json({ success: false, message: "Seller not found" });
    }

    req.user = { userId: decoded.userId };
    req.seller = seller;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

/** Blocks sellers that an admin has not approved yet (or has disabled). */
export const requireApprovedSeller = (req, res, next) => {
  if (!req.seller?.status) {
    return res.status(403).json({
      success: false,
      message: "Your seller account is awaiting admin approval",
    });
  }
  next();
};
