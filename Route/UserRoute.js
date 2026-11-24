import express from "express";
import {
  ProductType,
  getCategory,
  getDetails,
  getProduct,
  getSellers,
  getSubCategories,
  getSubCategory,
  relatedProduct,
  getProductsByType,
  getProductsBySeller,
  clearCacheHandler,
  getAllCategories,
  getCategoriesWithSubcategories,
} from "../Controller/UserController.js";
import {
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  getCart,
  addToWishlist,
  removeFromWishlist,
  getWishlist,
  moveToCart,
  getCartSummary,
  getCartBySeller,
} from "../Controller/CartController.js";
import {
  register,
  login,
  googleAuth,
  getGuestUser,
  logout,
  getProfile,
  updateProfile,
  verifyToken,
  verifyEmail,
  resendOtp,
  forgotPassword,
  resetPassword,
} from "../Controller/AuthController.js";
import {
  createOrder,
  verifyPayment,
  getOrder,
  getUserOrders,
  cancelOrder,
  cancelOrderItem,
  getOrderDetails,
  requestReturn,
  trackOrder,
} from "../Controller/OrderController.js";
import { razorpayWebhook } from "../Controller/WebhookController.js";
import { authMiddleware, requireRegisteredUser } from "../Middleware/Auth.js";

const UserRoute = express.Router();

/* ---------- auth ---------- */
UserRoute.post("/register", register);
UserRoute.post("/login", login);
UserRoute.post("/verify-otp", verifyEmail);
UserRoute.post("/resend-otp", resendOtp);
UserRoute.post("/forgot-password", forgotPassword);
UserRoute.post("/reset-password", resetPassword);
UserRoute.post("/google-auth", googleAuth);
UserRoute.post("/guest", getGuestUser);
UserRoute.post("/logout", authMiddleware, logout);
UserRoute.get("/profile", authMiddleware, getProfile);
UserRoute.put("/profile", authMiddleware, updateProfile);
UserRoute.get("/verify-token", verifyToken);

/* ---------- catalog (public) ---------- */
UserRoute.get(["/products", "/get-product"], getProduct);
UserRoute.get(["/product/:id", "/get-product/:id"], getDetails);
UserRoute.get("/products/type/:type/:subCategoryId?/:sellerId?", getProductsByType);
UserRoute.get("/products/seller/:sellerId", getProductsBySeller);
UserRoute.get(["/products/related/:seller/:category", "/get-related/:seller/:category"], relatedProduct);
UserRoute.get("/categories/with-subcategories", getCategoriesWithSubcategories);
UserRoute.get(["/categories/:id", "/get-category/:id"], getCategory);
UserRoute.get(["/subcategories/:id", "/get-subcategories/:id"], getSubCategories);
UserRoute.get(["/subcategory/:id/:category", "/get-subcategory/:id/:category"], getSubCategory);
UserRoute.get(["/types/:id", "/get-type/:id"], ProductType);
UserRoute.get("/all-categories", getAllCategories);
UserRoute.get(["/sellers", "/get-sellers"], getSellers);
UserRoute.get("/clear-cache", clearCacheHandler);

/* ---------- cart & wishlist (guest or registered) ---------- */
UserRoute.post("/cart/add", authMiddleware, addToCart);
UserRoute.put("/cart/update", authMiddleware, updateCartItem);
UserRoute.delete("/cart/remove/:cartItemId", authMiddleware, removeFromCart);
UserRoute.delete("/cart/clear", authMiddleware, clearCart);
UserRoute.get("/cart", authMiddleware, getCart);
UserRoute.get("/cart/summary", authMiddleware, getCartSummary);
UserRoute.get("/cart/by-seller", authMiddleware, getCartBySeller);

UserRoute.post("/wishlist/add", authMiddleware, addToWishlist);
UserRoute.delete("/wishlist/remove/:productId", authMiddleware, removeFromWishlist);
UserRoute.get("/wishlist", authMiddleware, getWishlist);
UserRoute.post("/wishlist/move-to-cart", authMiddleware, moveToCart);

/* ---------- orders (registered users only) ---------- */
UserRoute.post("/order/create", authMiddleware, requireRegisteredUser, createOrder);
UserRoute.post("/payment/verify", authMiddleware, requireRegisteredUser, verifyPayment);
UserRoute.get("/orders", authMiddleware, getUserOrders);
UserRoute.get("/order/:orderId", authMiddleware, getOrder);
UserRoute.get("/order/:orderId/details", authMiddleware, getOrderDetails);
UserRoute.post("/order/:orderId/cancel", authMiddleware, cancelOrder);
UserRoute.post("/order/:orderId/cancel-item", authMiddleware, cancelOrderItem);
UserRoute.post("/order/:orderId/return", authMiddleware, requestReturn);
UserRoute.get("/order/:orderId/track", authMiddleware, trackOrder);

// Razorpay server-to-server webhook: no user session, verified via x-razorpay-signature.
UserRoute.post("/webhook/razorpay", razorpayWebhook);

export default UserRoute;
