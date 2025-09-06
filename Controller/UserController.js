import categoryModel from "../Model/CategoryModel.js"
import productModel from "../Model/ProductModel.js"
import SellerModel from "../Model/SellerModel.js";
import subcategoryModel from "../Model/SubCategoryModel.js";
import mongoose from "mongoose";





export const getProduct = async(req,res)=>{
    try {
        const products = await productModel.find()
        .sort({ createdAt: -1 });
        if(products){
            res.status(200).json(products)
        }
    } catch (error) {
        res.status(500).json({message:"Internal server error"})
    }
}


export const getCategory = async(req,res)=>{
    try {

        const {id} = req.params

        console.log("the id is getti",id)

        const seller = await SellerModel.findOne({_id:id})
        console.log("llll")

        console.log(seller,"is heree getting ")
        const category = await categoryModel.find({
            _id:{$in:seller.categories}
        });

        console.log(category,"the category is gettting ")
    if(category){
        res.status(200).json(category)
    }
    } catch (error) {
      res.status(500).json({message:"Internal server error"})
    }
}
export const getSubCategories = async(req,res)=>{
    try {

        const id = req.params.id
        const category = await subcategoryModel.find({categoryId:id})
    if(category){
        res.status(200).json(category)
    }
    } catch (error) {
      res.status(500).json({message:"Internal server error"})
    }
}


export const getDetails = async(req,res)=>{
    try {
        const {id} = req.params

        const product = await productModel.findById(id).populate('subCategoryId', 'name').populate("seller",)

        console.log(product,"this eb thge prodiuct sending ")
        res.status(200).json(product)
    } catch (error) {
        res.status(500).json({message:"Internal server error"})
    }
}


export const getSubCategory = async (req, res) => {
    try {
      const sellerId = req.params.id;
      const categoryId = req.params.category;
      
      console.log("Fetching subcategories for seller:", sellerId, "and category:", categoryId);
      
      // First, verify that products exist with these parameters
      const productCount = await productModel.countDocuments({
        seller: new mongoose.Types.ObjectId(sellerId),
        categoryId: new mongoose.Types.ObjectId(categoryId)
      });
      
      console.log("Found", productCount, "products matching criteria");
      
      if (productCount === 0) {
        return res.status(404).json({ 
          message: "No products found for this seller & category" 
        });
      }
      
      const subcategories = await productModel.aggregate([
        {
          $match: {
            seller: new mongoose.Types.ObjectId(sellerId),
            categoryId: new mongoose.Types.ObjectId(categoryId)
          }
        },
        {
          $group: {
            _id: "$subCategoryId",
            count: { $sum: 1 }
          }
        },
        // Add this stage to see what we're getting before the lookup
        {
          $project: {
            _id: 1,
            count: 1,
            idType: { $type: "$_id" }
          }
        },
        {
          $lookup: {
            from: "subcategories", // Make sure this matches your actual collection name
            localField: "_id",
            foreignField: "_id",
            as: "subcategoryDetails"
          }
        },
        {
          $project: {
            _id: 1,
            count: 1,
            idType: 1,
            subcategoryDetails: 1,
            subcategoryDetailsLength: { $size: "$subcategoryDetails" }
          }
        },
        {
          $match: {
            subcategoryDetailsLength: { $gt: 0 }
          }
        },
        {
          $unwind: "$subcategoryDetails"
        },
        {
          $project: {
            _id: "$subcategoryDetails._id",
            name: "$subcategoryDetails.name",
            image: "$subcategoryDetails.image",
            itemCount: "$count"
          }
        }
      ]);
  
      console.log("Aggregation result:", JSON.stringify(subcategories, null, 2));
      
      if (!subcategories.length) {
        return res.status(404).json({ 
          message: "Subcategories found in products but no matching records in subcategories collection" 
        });
      }
  
      res.status(200).json(subcategories);
    } catch (error) {
      console.error("Subcategory fetch error:", error);
      res.status(500).json({ 
        message: "Internal server error", 
        error: error.message 
      });
    }
}

export const ProductType = async(req,res)=>{
    try {
        const {id} = req.params

        const type = await ProductTypeModel.find({subCategoryId:id})
        if(!type){
            res.status(404).json({message:"subcategory not found"})
        }
        res.status(200).json(type)
    } catch (error) {
        res.status(500).json({message:"Internal server error"})
    }
}

export const relatedProduct = async (req, res) => {
    try {
      const subCategoryId = req.params.category;
      const sellerId = req.params.seller;
      
      console.log("Finding related products for subCategory:", subCategoryId, "and seller:", sellerId);
      
      const subCategoryObjectId = new mongoose.Types.ObjectId(subCategoryId);
      const sellerObjectId = new mongoose.Types.ObjectId(sellerId);
      
      const products = await productModel.find({ 
        subCategoryId: subCategoryObjectId,
        seller: sellerObjectId,
        active: true 
      })
      .populate("subCategoryId")
      .populate("categoryId")
      .populate("seller", "name Image");
      
      console.log(`Found ${products.length} related products`);
      
      if (!products.length) {
        return res.status(404).json({ 
          message: "No related products found for this subcategory and seller" 
        });
      }
      
      res.status(200).json(products);
    } catch (error) {
      console.error("Related products fetch error:", error);
      res.status(500).json({ 
        message: "Internal server error", 
        error: error.message 
      });
    }
  };

export const getSellers = async(req,res)=>{
    try {

        console.log("jiiiibhueiheih")
        const sellers = await SellerModel.find()

        console.log(sellers,"the sellers ")

        res.status(200).json(sellers)
    } catch (error) {
        console.error(error)
        res.status(500).json({message:"internal server error"})
    }
}