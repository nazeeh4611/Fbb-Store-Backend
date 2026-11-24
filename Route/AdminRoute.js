import express from "express";
import {
  addCategory,
  getCategory,
  addSubcategory,
  getSubCategory,
  updateTrending,
  SignUp,
  login,
  editCategory,
  getSellers,
  updateStatus,
  getSellerProduct,
  sellerByid,
  getProducts,
  editSubcategory,
} from "../Controller/AdminController.js";
import { getDashboard, getOrders, getOrderById } from "../Controller/AdminInsightsController.js";
import { adminAuthMiddleware } from "../Middleware/AdminAuth.js";
import { imageUpload } from "../Utils/upload.js";

const adminRouter = express.Router();

const categoryUpload = imageUpload("category-fbb");

// Public: auth
adminRouter.post("/register", SignUp); // guarded inside the controller (setup key / first admin only)
adminRouter.post("/login", login);

// Public: read-only catalog structure (used by the seller product form too)
adminRouter.get("/get-category", getCategory);
adminRouter.get("/get-subcategory", getSubCategory);

// Everything below requires an admin token
adminRouter.use(adminAuthMiddleware);

adminRouter.post("/add-category", categoryUpload.single("image"), addCategory);
adminRouter.put("/edit-category", categoryUpload.single("image"), editCategory);
adminRouter.post("/add-subcategory", categoryUpload.single("image"), addSubcategory);
adminRouter.put("/edit-subcategory/:id", categoryUpload.single("image"), editSubcategory);
adminRouter.put("/update-trending/:id", updateTrending);
adminRouter.get("/get-sellers", getSellers);
adminRouter.put("/update-status/:id", updateStatus);
adminRouter.get("/get-products/:id", getSellerProduct);
adminRouter.get("/get-seller/:id", sellerByid);
adminRouter.get("/get-products", getProducts);
adminRouter.get("/dashboard", getDashboard);
adminRouter.get("/orders", getOrders);
adminRouter.get("/orders/:id", getOrderById);

export default adminRouter;
