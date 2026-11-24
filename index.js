import "dotenv/config"; // must be the first import so env vars exist before other modules load

import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import adminRouter from "./Route/AdminRoute.js";
import UserRoute from "./Route/UserRoute.js";
import SellerRouter from "./Route/SellerRoute.js";
import databaseConnection from "./Utils/Db.js";

const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

// Render / Railway / Vercel sit behind a proxy; needed for correct client IPs in rate limiting.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());

// Keep the raw body so the Razorpay webhook signature can be verified.
const rawBodySaver = (req, _res, buf) => {
  if (buf && buf.length) req.rawBody = buf;
};
app.use(express.json({ limit: "2mb", verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://flybuybrand.com",
  "https://www.flybuybrand.com",
  "https://fbb-store-e-commerce.vercel.app",
];
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const origins = allowedOrigins.length ? allowedOrigins : defaultOrigins;

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server calls (no Origin header) e.g. Razorpay webhooks, health checks
      if (!origin || origins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "device-id"],
    credentials: true,
    maxAge: 86400,
  })
);

// Health check (used by the frontend to wake a sleeping free-tier instance, and by uptime monitors)
app.get(["/health", "/api/health"], (_req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "connecting",
    uptime: Math.round(process.uptime()),
  });
});

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again in a few minutes." },
});
app.use("/api", apiLimiter);
app.use(
  [
    "/api/login",
    "/api/register",
    "/api/verify-otp",
    "/api/resend-otp",
    "/api/forgot-password",
    "/api/reset-password",
    "/api/admin/login",
    "/api/admin/register",
    "/api/seller/login",
    "/api/seller/register",
  ],
  authLimiter
);

app.use("/api/admin", adminRouter);
app.use("/api/seller", SellerRouter);
app.use("/api", UserRoute);

app.get("/", (_req, res) => res.json({ status: "ok", service: "fbb-store-api" }));

// 404 for unknown API routes
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Central error handler (multer, JSON parse errors, anything thrown in a route)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: status === 500 && isProd ? "Internal server error" : err.message || "Internal server error",
  });
});

const start = async () => {
  await databaseConnection();
  const server = app.listen(PORT, "0.0.0.0", () => console.log(`Server is running at port ${PORT}`));

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      mongoose.connection.close(false).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

start();
