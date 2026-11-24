import express from "express";
import {
  SignUp,
  addProduct,
  deleteProduct,
  getProducts,
  login,
  resetPassword,
  updateProduct,
  updateProfile,
  getSellerOrders,
  updateOrderStatus,
  getSellerDashboardStats,
  getSellerProfile,
} from "../Controller/SellerController.js";
import { getSalesReport } from "../Controller/OrderController.js";
import { sellerAuthMiddleware, requireApprovedSeller } from "../Middleware/Sellerauth.js";
import { imageUpload, handleProductMedia } from "../Utils/upload.js";

const SellerRouter = express.Router();
const profileImageUpload = imageUpload("product-fbb/profiles");

SellerRouter.post("/register", SignUp);
SellerRouter.post("/login", login);

// Password change (the dashboard historically POSTed to /reset-password/:id)
SellerRouter.put("/reset-password", sellerAuthMiddleware, resetPassword);
SellerRouter.post("/reset-password/:id?", sellerAuthMiddleware, resetPassword);

SellerRouter.get("/profile/:id", sellerAuthMiddleware, getSellerProfile);
SellerRouter.put(
  "/update-profile/:id?",
  sellerAuthMiddleware,
  profileImageUpload.single("profileImage"),
  updateProfile
);

SellerRouter.get("/get-products/:id", sellerAuthMiddleware, getProducts);
SellerRouter.post("/add-product", sellerAuthMiddleware, requireApprovedSeller, handleProductMedia, addProduct);
SellerRouter.put("/edit-product/:id", sellerAuthMiddleware, requireApprovedSeller, handleProductMedia, updateProduct);
SellerRouter.delete("/delete-product/:id", sellerAuthMiddleware, deleteProduct);

SellerRouter.get("/orders", sellerAuthMiddleware, getSellerOrders);
SellerRouter.post("/orders/update-status", sellerAuthMiddleware, updateOrderStatus);
SellerRouter.get("/dashboard/stats", sellerAuthMiddleware, getSellerDashboardStats);
SellerRouter.get("/sales-report", sellerAuthMiddleware, getSalesReport);

export default SellerRouter;
