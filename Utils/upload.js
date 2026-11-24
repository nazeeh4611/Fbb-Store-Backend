import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn("[upload] Cloudinary credentials are missing - image uploads will fail");
}

const IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp", "avif"];
const VIDEO_FORMATS = ["mp4", "mov", "webm"];

const safeName = (name = "") =>
  name
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 60);

const imageFilter = (_req, file, cb) => {
  if (file.mimetype?.startsWith("image/")) return cb(null, true);
  cb(Object.assign(new Error("Only image files are allowed"), { status: 400 }));
};

const mediaFilter = (_req, file, cb) => {
  const isVideoField = file.fieldname.startsWith("video");
  const ok = isVideoField ? file.mimetype?.startsWith("video/") : file.mimetype?.startsWith("image/");
  if (ok) return cb(null, true);
  cb(Object.assign(new Error(`Invalid file type for ${file.fieldname}`), { status: 400 }));
};

/** Single-image uploads (categories, profile pictures). */
export const imageUpload = (folder) =>
  multer({
    storage: new CloudinaryStorage({
      cloudinary,
      params: async (_req, file) => ({
        folder,
        resource_type: "image",
        allowed_formats: IMAGE_FORMATS,
        transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }],
        public_id: `${Date.now()}-${safeName(file.originalname)}`,
      }),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: imageFilter,
  });

/** Product images (image1..4) and videos (video1..2). */
export const productMediaUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: async (_req, file) => {
      const isVideo = file.fieldname.startsWith("video");
      return {
        folder: "product-fbb/products",
        resource_type: isVideo ? "video" : "image",
        allowed_formats: isVideo ? VIDEO_FORMATS : IMAGE_FORMATS,
        ...(isVideo
          ? {}
          : { transformation: [{ width: 2000, height: 2000, crop: "limit", quality: "auto", fetch_format: "auto" }] }),
        public_id: `${file.fieldname}-${Date.now()}`,
      };
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: mediaFilter,
});

export const PRODUCT_MEDIA_FIELDS = [
  { name: "image1", maxCount: 1 },
  { name: "image2", maxCount: 1 },
  { name: "image3", maxCount: 1 },
  { name: "image4", maxCount: 1 },
  { name: "video1", maxCount: 1 },
  { name: "video2", maxCount: 1 },
  { name: "video3", maxCount: 1 },
  { name: "video4", maxCount: 1 },
];

/** Wraps multer so upload errors come back as clean JSON 400s. */
export const handleProductMedia = (req, res, next) => {
  productMediaUpload.fields(PRODUCT_MEDIA_FIELDS)(req, res, (err) => {
    if (err) {
      console.error("[upload] product media error:", err.message);
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "File is too large (max 25MB)"
          : err.code === "LIMIT_UNEXPECTED_FILE"
          ? `Unexpected file field: ${err.field}`
          : err.message || "Upload failed";
      return res.status(400).json({ success: false, message, error: message });
    }
    next();
  });
};
