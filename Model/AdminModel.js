import mongoose from "mongoose";

const AdminSchema = new mongoose.Schema(
    {
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
    },
    { timestamps: true }
  );

const AdminModel = mongoose.model("Admin", AdminSchema);

export default AdminModel;
