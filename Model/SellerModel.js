import mongoose from "mongoose";

const SellerSchema = new mongoose.Schema(
    {
      name : {
       type:String,
       required:true
      },
      email: {
        type: String,
        unique: true,
        trim: true,
        sparse: true,  
        lowercase: true
      },
      phone: {
        type: String,
        unique: true,
        trim: true,
        sparse: true  
      },
      password: {
        type: String,
        required: true,
        trim: true
      },
      status:{
        type:Boolean,
        default:false
      },
      INR:{
        type:String,
      },
      DXB:{
        type:String
      },
      Image:{
        type:String
      },
      categories: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Category'
        }
      ],
    },
    
    { timestamps: true }
  );

const SellerModel = mongoose.model("Seller", SellerSchema);

export default SellerModel;


