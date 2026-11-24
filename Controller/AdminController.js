import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import productModel from "../Model/ProductModel.js";
import categoryModel from "../Model/CategoryModel.js";
import subcategoryModel from "../Model/SubCategoryModel.js";
import AdminModel from "../Model/AdminModel.js";
import SellerModel from "../Model/SellerModel.js";
import { invalidateCache } from "../Utils/cache.js";

const isId = (id) => mongoose.Types.ObjectId.isValid(id);

const signAdminToken = (admin) =>
  jwt.sign({ userId: admin._id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });

export const addCategory = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const image = req.file?.path;

    if (!name || !image) {
      return res.status(400).json({ message: "Name and image are required" });
    }

    const newCategory = await categoryModel.create({ name, image });
    invalidateCache();
    res.status(201).json({ message: "Category added successfully", category: newCategory });
  } catch (error) {
    console.error("Error adding category:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getCategory = async (_req, res) => {
  try {
    const categories = await categoryModel.find().sort({ name: 1 }).lean();
    res.status(200).json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const addSubcategory = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const { categoryId } = req.body;
    const image = req.file?.path;

    if (!name || !image) {
      return res.status(400).json({ message: "Name and image are required" });
    }
    if (!isId(categoryId) || !(await categoryModel.exists({ _id: categoryId }))) {
      return res.status(400).json({ message: "A valid parent category is required" });
    }

    const subcategory = await subcategoryModel.create({ name, categoryId, image });
    invalidateCache();
    res.status(201).json({ message: "Subcategory added successfully", category: subcategory });
  } catch (error) {
    console.error("Error adding subcategory:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getSubCategory = async (_req, res) => {
  try {
    const subcategories = await subcategoryModel.find().populate("categoryId").sort({ name: 1 }).lean();
    res.status(200).json(subcategories);
  } catch (error) {
    console.error("Error fetching subcategories:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const updateTrending = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Invalid product id" });

    const product = await productModel.findById(id).select("trending");
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const updatedProduct = await productModel.findByIdAndUpdate(
      id,
      { trending: !product.trending },
      { new: true }
    );
    invalidateCache();
    res.status(200).json(updatedProduct);
  } catch (error) {
    console.error("Error updating trending:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Admin registration is closed to the public.
 * Allowed only when (a) no admin exists yet (first-time setup), or
 * (b) the request carries the ADMIN_SETUP_KEY from the server environment.
 */
export const SignUp = async (req, res) => {
  try {
    const { email, phone, password, setupKey } = req.body;

    const adminCount = await AdminModel.estimatedDocumentCount();
    const keyOk = process.env.ADMIN_SETUP_KEY && setupKey === process.env.ADMIN_SETUP_KEY;
    if (adminCount > 0 && !keyOk) {
      return res.status(403).json({ message: "Admin registration is disabled" });
    }

    if (!email || !password || password.length < 8) {
      return res.status(400).json({ message: "Email and a password of at least 8 characters are required" });
    }

    const existing = await AdminModel.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedpass = await bcrypt.hash(password, 10);
    const admin = await AdminModel.create({ email, phone, password: hashedpass });

    res.status(201).json({ message: "Admin registered successfully", token: signAdminToken(admin) });
  } catch (error) {
    console.error("Admin signup error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const login = async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;

    if (!emailOrPhone || !password) {
      return res.status(400).json({ message: "Email/Phone and password are required" });
    }

    const identifier = String(emailOrPhone).trim();
    const admin = await AdminModel.findOne({
      $or: [{ email: identifier.toLowerCase() }, { phone: identifier }],
    });

    // Same response for unknown user and wrong password (no account enumeration)
    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    return res.status(200).json({
      message: "Login successful",
      token: signAdminToken(admin),
      user: { email: admin.email, phone: admin.phone, _id: admin._id },
    });
  } catch (error) {
    console.error("Admin login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const editCategory = async (req, res) => {
  try {
    const image = req.file?.path;
    const { name, categoryId } = req.body;
    if (!isId(categoryId)) return res.status(400).json({ message: "Invalid category id" });

    const update = {};
    if (name?.trim()) update.name = name.trim();
    if (image) update.image = image; // keep the old image if none uploaded

    const response = await categoryModel.updateOne({ _id: categoryId }, update);
    invalidateCache();
    res.status(200).json(response);
  } catch (error) {
    console.error("Error editing category:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const editSubcategory = async (req, res) => {
  try {
    const image = req.file?.path;
    const { name, categoryId } = req.body;
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Invalid subcategory id" });

    const update = {};
    if (name?.trim()) update.name = name.trim();
    if (image) update.image = image;
    if (categoryId && isId(categoryId)) update.categoryId = categoryId;

    const response = await subcategoryModel.updateOne({ _id: id }, update);
    invalidateCache();
    res.status(200).json(response);
  } catch (error) {
    console.error("Error editing subcategory:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getSellers = async (_req, res) => {
  try {
    const sellers = await SellerModel.find().select("-password").sort({ createdAt: -1 }).lean();
    res.status(200).json(sellers);
  } catch (error) {
    console.error("Error fetching sellers:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Invalid seller id" });

    const seller = await SellerModel.findById(id).select("status");
    if (!seller) return res.status(404).json({ message: "Seller not found" });

    const update = await SellerModel.findByIdAndUpdate(
      id,
      { status: !seller.status },
      { new: true }
    ).select("-password");

    invalidateCache();
    res.json({ success: true, seller: update });
  } catch (error) {
    console.error("Error updating seller status:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getSellerProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Invalid seller id" });

    const products = await productModel
      .find({ seller: id })
      .populate("categoryId", "name")
      .populate("subCategoryId", "name")
      .populate("seller", "name")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(products);
  } catch (error) {
    console.error("Error fetching seller products:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const sellerByid = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ message: "Invalid seller id" });

    const seller = await SellerModel.findById(id).select("-password").lean();
    if (!seller) return res.status(404).json({ message: "Seller not found" });
    res.status(200).json(seller);
  } catch (error) {
    console.error("Error fetching seller:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getProducts = async (_req, res) => {
  try {
    const products = await productModel
      .find()
      .populate("categoryId", "name")
      .populate("subCategoryId", "name")
      .populate("seller", "name")
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
