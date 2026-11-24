import mongoose from "mongoose";

mongoose.set("strictQuery", true);

const databaseConnection = async () => {
  const MONGO = process.env.MONGO_URI;
  if (!MONGO) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO, {
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 20,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }

  mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected"));
};

export default databaseConnection;
