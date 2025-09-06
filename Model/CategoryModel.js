import mongoose from "mongoose";

const CategorySchema = new mongoose.Schema({
    name:{
        type:String,
        required:true
    },
   image:{
     type:String,
    }
},{timestamps:true});

const categoryModel = mongoose.model('Category',CategorySchema);

export default categoryModel;