import mongoose from "mongoose";


const SubcategorySchema = new  mongoose.Schema({
    name: String, 
    categoryId: {type:mongoose.Types.ObjectId, ref: 'Category',},
    image:String
  },{timestamps:true});
  
  const subcategoryModel = mongoose.model("subcategory",SubcategorySchema)

  export default subcategoryModel
  