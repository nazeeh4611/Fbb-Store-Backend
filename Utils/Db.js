import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const databaseConnection = async () => {
  const MONGO = process.env.MONGO_URI;
  if (!MONGO) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

export default databaseConnection;
