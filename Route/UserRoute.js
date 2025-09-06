import express from "express";
const UserRoute = express.Router();
import dotenv from 'dotenv';
import { ProductType, getCategory, getDetails, getProduct, getSellers, getSubCategories, getSubCategory, relatedProduct } from "../Controller/UserController.js";
dotenv.config();



UserRoute.get("/get-product",getProduct)
UserRoute.get("/get-category/:id",getCategory)
UserRoute.get("/get-category/:id",getSubCategories)
UserRoute.get("/get-product/:id",getDetails)
UserRoute.get("/get-subcategory/:id/:category",getSubCategory)
UserRoute.get("/get-type/:id",ProductType)
UserRoute.get("/get-related/:seller/:category",relatedProduct)
UserRoute.get("/get-sellers",getSellers)
// Routes


export default UserRoute;