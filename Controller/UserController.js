import categoryModel from "../Model/CategoryModel.js"
import productModel from "../Model/ProductModel.js"
import SellerModel from "../Model/SellerModel.js";
import subcategoryModel from "../Model/SubCategoryModel.js";
import mongoose from "mongoose";

import { getFromCache, setToCache, invalidateCache } from "../Utils/cache.js";

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 100);
const toPage = (v) => Math.max(1, parseInt(v, 10) || 1);
const toLimit = (v, def = 20) => Math.min(100, Math.max(1, parseInt(v, 10) || def));

/** Ids of sellers an admin has approved. Products of other sellers are hidden from the store. */
const getApprovedSellerIds = async () => {
    const cached = getFromCache("approved-sellers");
    if (cached) return cached;
    const sellers = await SellerModel.find({ status: true }).select("_id").lean();
    const ids = sellers.map((s) => s._id);
    setToCache("approved-sellers", ids, 60 * 1000);
    return ids;
};

const VISIBLE = { active: true, deleted: { $ne: true } };

export const getProduct = async(req,res)=>{
    try {
        const { 
          page = 1, 
          limit = 20, 
          search = '', 
          category, 
          subcategory, 
          seller,
          trending = false 
        } = req.query;
        
        const pageNum = toPage(page);
        const limitNum = toLimit(limit);
        const skip = (pageNum - 1) * limitNum;

        const cacheKey = `products:${pageNum}:${limitNum}:${search}:${category}:${subcategory}:${seller}:${trending}`;
        
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
          return res.status(200).json(cachedData);
        }
        
        const approvedSellers = await getApprovedSellerIds();
        let query = { ...VISIBLE, seller: { $in: approvedSellers } };

        if (search && String(search).trim()) {
            const rx = escapeRegex(String(search).trim());
            query.$or = [
                { name: { $regex: rx, $options: 'i' } },
                { brand: { $regex: rx, $options: 'i' } },
                { tags: { $regex: rx, $options: 'i' } },
                { description: { $regex: rx, $options: 'i' } }
            ];
        }
        
        if (category && mongoose.Types.ObjectId.isValid(category)) {
            query.categoryId = new mongoose.Types.ObjectId(category);
        }
        
        if (subcategory && mongoose.Types.ObjectId.isValid(subcategory)) {
            query.subCategoryId = new mongoose.Types.ObjectId(subcategory);
        }
        
        if (seller && mongoose.Types.ObjectId.isValid(seller)) {
            const isApproved = approvedSellers.some((id) => id.toString() === seller);
            query.seller = isApproved ? new mongoose.Types.ObjectId(seller) : { $in: [] };
        }
        
        if (trending === 'true') {
            query.trending = true;
        }
        
        const total = await productModel.countDocuments(query);
        
        const products = await productModel.find(query)
            .select('name brand priceINR priceAED shortDescription images categoryId subCategoryId seller trending featured stock discount colors sizes rating createdAt')
            .populate('categoryId', 'name')
            .populate('seller', 'name companyName profileImage')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean();
        
        if(!products || products.length === 0){
            return res.status(200).json({ 
                success: true,
                products: [],
                total: 0,
                page: pageNum,
                totalPages: 0
            });
        }
        
        const response = {
            success: true,
            products,
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum)
        };

        setToCache(cacheKey, response);

        res.status(200).json(response);
    } catch (error) {
        console.error("Get product error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const getCategory = async(req,res)=>{
    try {
        const {id} = req.params;
        const cacheKey = `categories:${id}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                success: false,
                message: "Invalid seller ID format" 
            });
        }

        const seller = await SellerModel.findById(id).select('categories').lean();

        if (!seller) {
            return res.status(404).json({ 
                success: false,
                message: "Seller not found" 
            });
        }

        if (!seller.categories || seller.categories.length === 0) {
            return res.status(200).json({ 
                success: true,
                categories: []
            });
        }

        const categories = await categoryModel.find({
            _id: { $in: seller.categories },
        }).select('name image description').lean();

        const response = {
            success: true,
            categories: categories || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get category error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const getSubCategories = async(req,res)=>{
    try {
        const { id } = req.params;
        
        const cacheKey = `subcategories:${id}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(200).json({ 
                success: true,
                subcategories: []
            });
        }

        const subcategories = await subcategoryModel.find({
            categoryId: id
        }).select('name image description').sort({ name: 1 }).lean();


        const response = {
            success: true,
            subcategories: subcategories || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get subcategories error:", error);
        res.status(200).json({
            success: true,
            subcategories: []
        });
    }
}

export const getDetails = async(req,res)=>{
    try {
        const {id} = req.params;
        
        const cacheKey = `product:${id}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                success: false,
                message: "Invalid product ID format" 
            });
        }

        const product = await productModel.findById(id)
            .select('-__v')
            .populate('subCategoryId', 'name image')
            .populate('categoryId', 'name')
            .populate('seller', 'name companyName profileImage address city state INR DXB status')
            .lean();

        if (!product || !product.active || product.deleted || !product.seller?.status) {
            return res.status(404).json({ 
                success: false,
                message: "Product not found" 
            });
        }

        const response = {
            success: true,
            product
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get details error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const getSubCategory = async (req, res) => {
    try {
        const sellerId = req.params.id;
        const categoryId = req.params.category;
        
        const cacheKey = `seller-category:${sellerId}:${categoryId}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        if (!mongoose.Types.ObjectId.isValid(sellerId) || 
            !mongoose.Types.ObjectId.isValid(categoryId)) {
            return res.status(400).json({ 
                success: false,
                message: "Invalid seller or category ID format" 
            });
        }

        const sellerObjectId = new mongoose.Types.ObjectId(sellerId);
        const categoryObjectId = new mongoose.Types.ObjectId(categoryId);

        const subcategories = await productModel.aggregate([
            {
                $match: {
                    seller: sellerObjectId,
                    categoryId: categoryObjectId,
                    active: true,
                    deleted: { $ne: true },
                }
            },
            {
                $group: {
                    _id: "$subCategoryId",
                    productCount: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: "subcategories",
                    localField: "_id",
                    foreignField: "_id",
                    as: "subcategoryInfo"
                }
            },
            {
                $unwind: "$subcategoryInfo"
            },
            {
                $project: {
                    _id: "$subcategoryInfo._id",
                    name: "$subcategoryInfo.name",
                    image: "$subcategoryInfo.image",
                    description: "$subcategoryInfo.description",
                    itemCount: "$productCount"
                }
            },
            {
                $sort: { name: 1 }
            }
        ]);

        const response = {
            success: true,
            subcategories: subcategories || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get subcategory error:", error);
        res.status(500).json({ 
            success: false,
            message: "Internal server error"
        });
    }
}

export const ProductType = async(req,res)=>{
    try {
        const {id} = req.params;
        
        const cacheKey = `types:${id}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                success: false,
                message: "Invalid subcategory ID format" 
            });
        }

        const types = await productModel.aggregate([
            {
                $match: {
                    subCategoryId: new mongoose.Types.ObjectId(id),
                    active: true,
                    deleted: { $ne: true },
                    type: { $exists: true, $ne: "" }
                }
            },
            {
                $group: {
                    _id: "$type",
                    count: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    type: "$_id",
                    count: 1
                }
            },
            {
                $sort: { type: 1 }
            }
        ]);

        const response = {
            success: true,
            types: types || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Product type error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const relatedProduct = async (req, res) => {
    try {
        const subCategoryId = req.params.category;
        const sellerId = req.params.seller;
        
        const cacheKey = `related:${subCategoryId}:${sellerId}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        if (!mongoose.Types.ObjectId.isValid(subCategoryId) || 
            !mongoose.Types.ObjectId.isValid(sellerId)) {
            return res.status(400).json({ 
                success: false,
                message: "Invalid subcategory or seller ID format" 
            });
        }

        const subCategoryObjectId = new mongoose.Types.ObjectId(subCategoryId);
        const sellerObjectId = new mongoose.Types.ObjectId(sellerId);
        
        const products = await productModel.find({ 
            subCategoryId: subCategoryObjectId,
            seller: sellerObjectId,
            ...VISIBLE
        })
        .select('name brand priceINR priceAED images stock discount')
        .populate("seller", "name companyName")
        .limit(10)
        .sort({ createdAt: -1 })
        .lean();
        
        const response = {
            success: true,
            products: products || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Related products error:", error);
        res.status(500).json({ 
            success: false,
            message: "Internal server error"
        });
    }
};

export const getSellers = async(req,res)=>{
    try {
        const cacheKey = 'sellers';
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        const sellers = await SellerModel.find({ status: true })
            .select('name companyName profileImage address city state country categories createdAt')
            .sort({ name: 1 })
            .lean();

        const response = {
            success: true,
            sellers: sellers || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get sellers error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const getProductsByType = async(req,res)=>{
    try {
        const { type, subCategoryId, sellerId } = req.params;
        const page = toPage(req.query.page);
        const limit = toLimit(req.query.limit);
        const skip = (page - 1) * limit;

        const cacheKey = `products-type:${type}:${subCategoryId}:${sellerId}:${page}:${limit}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }
        
        let query = {
            ...VISIBLE,
            type: String(type)
        };
        
        if (mongoose.Types.ObjectId.isValid(subCategoryId)) {
            query.subCategoryId = new mongoose.Types.ObjectId(subCategoryId);
        }
        
        if (mongoose.Types.ObjectId.isValid(sellerId)) {
            query.seller = new mongoose.Types.ObjectId(sellerId);
        }
        
        const total = await productModel.countDocuments(query);
        const products = await productModel.find(query)
            .select('name brand priceINR priceAED images')
            .populate('seller', 'name companyName')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();
        
        const response = {
            success: true,
            products: products || [],
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get products by type error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const getProductsBySeller = async(req,res)=>{
    try {
        const { sellerId } = req.params;
        const page = toPage(req.query.page);
        const limit = toLimit(req.query.limit);
        const skip = (page - 1) * limit;

        const cacheKey = `products-seller:${sellerId}:${page}:${limit}`;
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }
        
        if (!mongoose.Types.ObjectId.isValid(sellerId)) {
            return res.status(400).json({ 
                success: false,
                message: "Invalid seller ID format" 
            });
        }
        
        const query = { 
            seller: new mongoose.Types.ObjectId(sellerId),
            ...VISIBLE
        };
        
        const total = await productModel.countDocuments(query);
        const products = await productModel.find(query)
            .select('name brand priceINR priceAED images categoryId')
            .populate('categoryId', 'name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();
        
        const response = {
            success: true,
            products: products || [],
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get products by seller error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const clearCacheHandler = async (req, res) => {
    try {
        const { key } = req.query;
        if (process.env.CACHE_CLEAR_KEY && key === process.env.CACHE_CLEAR_KEY) {
            invalidateCache();
            res.status(200).json({ success: true, message: 'Cache cleared' });
        } else {
            res.status(401).json({ success: false, message: 'Unauthorized' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

export const getAllCategories = async(req,res)=>{
    try {
        const cacheKey = 'all-categories';
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        const categories = await categoryModel.find()
            .select('name image')
            .sort({ name: 1 })
            .lean();

        const response = {
            success: true,
            categories: categories || []
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get all categories error:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

export const getCategoriesWithSubcategories = async (req, res) => {
    try {
        const cacheKey = 'categories:with-subcategories';
        
        const cachedData = getFromCache(cacheKey);
        if (cachedData) {
            return res.status(200).json(cachedData);
        }

        const categories = await categoryModel.find()
            .select('_id name image')
            .sort({ name: 1 })
            .lean();

        if (!categories || categories.length === 0) {
            const response = { success: true, categories: [] };
            setToCache(cacheKey, response);
            return res.status(200).json(response);
        }

        const allSubs = await subcategoryModel.find({
            categoryId: { $in: categories.map((c) => c._id) }
        })
        .select('_id name image description categoryId')
        .sort({ name: 1 })
        .lean();

        const categoriesWithSubcategories = categories.map((category) => ({
            _id: category._id,
            name: category.name,
            image: category.image,
            subcategories: allSubs.filter((sub) => sub.categoryId?.toString() === category._id.toString())
        }));

        const response = {
            success: true,
            categories: categoriesWithSubcategories
        };
        
        setToCache(cacheKey, response);
        
        res.status(200).json(response);
    } catch (error) {
        console.error("Get categories with subcategories error:", error);
        res.status(200).json({
            success: true,
            categories: []
        });
    }
};

export default {
    getProduct,
    getCategory,
    getSubCategories,
    getDetails,
    getSubCategory,
    ProductType,
    relatedProduct,
    getSellers,
    getProductsByType,
    getProductsBySeller,
    clearCacheHandler,
    getAllCategories,
    getCategoriesWithSubcategories
};