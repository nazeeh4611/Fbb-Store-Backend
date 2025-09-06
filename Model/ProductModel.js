// 1. Updated Product Schema to include videos
import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  brand: {
    type: String,
    required: true
  },
  priceINR: {
    type: Number,
    required: true
  },
  priceAED: {
    type: Number,
    required: true
  },
  description:{
   type:String,
  },
  images: {
    image1: { type: String, required: true },  // First image is required
    image2: { type: String },
    image3: { type: String },
    image4: { type: String }
  },
  videos: {
    video1: { type: String },
    video2: { type: String }
  },
  subCategoryId:{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'subcategory',
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  seller:{
    type:mongoose.Schema.Types.ObjectId,
    ref:"Seller",
    required:true
  },
  active: {
    type: Boolean,
    default: true
  },
  trending:{
    type:Boolean,
    default:false
  }
}, { timestamps: true });

const productModel = mongoose.model('Product', ProductSchema);
export default productModel;