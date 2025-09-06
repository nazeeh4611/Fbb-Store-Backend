import express from "express";
import multer from "multer";
import { S3Client } from "@aws-sdk/client-s3";
import multerS3 from "multer-s3";
import dotenv from 'dotenv';
import { SignUp, addProduct, deleteProduct, getProducts, login, resetPassword, updateProduct, updateProfile } from "../Controller/SellerController.js";

dotenv.config();

const SellerRouter = express.Router();

const s3Client = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY || "",
    secretAccessKey: process.env.AWS_SECRET_KEY || "",
  },
});

const profileImageUpload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: "product-fbb",
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const fileName = `profile-${Date.now()}-${file.originalname}`;
      cb(null, fileName);
    },
  }),
});

// Updated to handle both images and videos
const mediaUpload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: "product-fbb",
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const fileName = `${Date.now()}-${file.fieldname}-${file.originalname}`;
      cb(null, fileName);
    },
  }),
});

const handleProductMedia = async (req, res, next) => {
  try {
    // Parse existing media if provided
    const existingImages = req.body.existingImages ? JSON.parse(req.body.existingImages) : {};
    const existingVideos = req.body.existingVideos ? JSON.parse(req.body.existingVideos) : {};
    
    req.existingImages = existingImages;
    req.existingVideos = existingVideos;
    
    const mediaFields = [
      { name: 'image1', maxCount: 1 },
      { name: 'image2', maxCount: 1 },
      { name: 'image3', maxCount: 1 },
      { name: 'image4', maxCount: 1 },
      { name: 'video1', maxCount: 1 },
      { name: 'video2', maxCount: 1 }
    ];
    
    return mediaUpload.fields(mediaFields)(req, res, (err) => {
      if (err) {
        console.error("Error uploading files:", err);
        return res.status(400).json({ error: `Error uploading files: ${err.message}` });
      }
      next();
    });
  } catch (error) {
    console.error("Error in handleProductMedia:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

SellerRouter.post("/register", SignUp);
SellerRouter.post("/login", login);

// Updated to use the handleProductMedia middleware
SellerRouter.post("/add-product", handleProductMedia, addProduct);

SellerRouter.get("/get-products/:id", getProducts);

// Updated to use the handleProductMedia middleware
SellerRouter.put("/edit-product/:id", handleProductMedia, updateProduct);

SellerRouter.post('/reset-password/:userId', resetPassword);

SellerRouter.put('/update-profile/:userId', profileImageUpload.single('profileImage'), updateProfile);

SellerRouter.delete("/delete-product/:id", deleteProduct);

export default SellerRouter;