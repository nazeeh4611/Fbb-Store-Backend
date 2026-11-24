// Read-only views for the admin panel: dashboard metrics and the order book.
import mongoose from "mongoose";
import OrderModel from "../Model/OrderModel.js";
import productModel from "../Model/ProductModel.js";
import SellerModel from "../Model/SellerModel.js";
import UserModel from "../Model/UserModel.js";
import { CONFIRMED_ORDER_FILTER } from "../Utils/orderService.js";

const REAL_ORDER = { status: { $ne: "temporary" }, ...CONFIRMED_ORDER_FILTER };
const ORDER_STATUSES = ["pending", "accepted", "processing", "partially_shipped", "shipped", "delivered", "cancelled", "returned"];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getDashboard = async (_req, res) => {
  try {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 29);

    const [
      revenueAgg,
      byStatus,
      daily,
      productCount,
      activeProducts,
      lowStock,
      sellerCount,
      pendingSellers,
      customerCount,
      recentOrders,
      topProducts,
    ] = await Promise.all([
      OrderModel.aggregate([
        { $match: { ...REAL_ORDER, status: { $nin: ["temporary", "cancelled", "returned"] } } },
        { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      ]),
      OrderModel.aggregate([{ $match: REAL_ORDER }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      OrderModel.aggregate([
        { $match: { ...REAL_ORDER, createdAt: { $gte: since }, status: { $nin: ["temporary", "cancelled"] } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      productModel.countDocuments({ deleted: { $ne: true } }),
      productModel.countDocuments({ deleted: { $ne: true }, active: true }),
      productModel
        .find({ deleted: { $ne: true }, active: true, stock: { $lte: 5 } })
        .select("name stock images.image1 seller")
        .populate("seller", "name companyName")
        .sort({ stock: 1 })
        .limit(8)
        .lean(),
      SellerModel.countDocuments({}),
      SellerModel.countDocuments({ status: { $ne: true } }),
      UserModel.countDocuments({ isGuest: { $ne: true } }),
      OrderModel.find(REAL_ORDER)
        .select("orderId total status paymentMethod paymentStatus createdAt shippingAddress.name user items")
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      OrderModel.aggregate([
        { $match: { ...REAL_ORDER, status: { $nin: ["temporary", "cancelled", "returned"] } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.product", units: { $sum: "$items.quantity" }, revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } } } },
        { $sort: { units: -1 } },
        { $limit: 5 },
        { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" } },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        { $project: { units: 1, revenue: 1, name: "$product.name", image: "$product.images.image1" } },
      ]),
    ]);

    // fill missing days so the chart has a continuous axis
    const series = [];
    const map = new Map(daily.map((d) => [d._id, d]));
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      const key = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const hit = map.get(key);
      series.push({ date: key, revenue: Math.round(hit?.revenue || 0), orders: hit?.orders || 0 });
    }

    const statusCounts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
    byStatus.forEach((s) => {
      if (s._id in statusCounts) statusCounts[s._id] = s.count;
    });

    res.json({
      success: true,
      stats: {
        revenue: Math.round(revenueAgg[0]?.revenue || 0),
        orders: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        paidOrders: revenueAgg[0]?.orders || 0,
        products: productCount,
        activeProducts,
        sellers: sellerCount,
        pendingSellers,
        customers: customerCount,
      },
      statusCounts,
      series,
      recentOrders: recentOrders.map((o) => ({
        ...o,
        itemCount: (o.items || []).reduce((n, i) => n + (i.quantity || 0), 0),
        items: undefined,
      })),
      lowStock,
      topProducts,
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).json({ success: false, message: "Failed to load dashboard" });
  }
};

export const getOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const { status, payment, search } = req.query;

    const query = { ...REAL_ORDER };
    if (status && ORDER_STATUSES.includes(status)) query.status = status;
    if (payment === "cod" || payment === "razorpay") query.paymentMethod = payment;
    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim()), "i");
      const users = await UserModel.find({ $or: [{ name: rx }, { email: rx }] }).select("_id").limit(50).lean();
      query.$and = [
        {
          $or: [
            { orderId: rx },
            { "shippingAddress.name": rx },
            { "shippingAddress.phone": rx },
            { user: { $in: users.map((u) => u._id) } },
          ],
        },
      ];
    }

    const [orders, total] = await Promise.all([
      OrderModel.find(query)
        .populate("user", "name email phone")
        .populate("items.product", "name images.image1")
        .populate("items.seller", "name companyName")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      OrderModel.countDocuments(query),
    ]);

    res.json({ success: true, orders, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("Admin orders error:", error);
    res.status(500).json({ success: false, message: "Failed to load orders" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id) ? { $or: [{ _id: id }, { orderId: id }] } : { orderId: id };
    const order = await OrderModel.findOne(query)
      .populate("user", "name email phone")
      .populate("items.product", "name images.image1 sku")
      .populate("items.seller", "name companyName email phone")
      .lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    res.json({ success: true, order });
  } catch (error) {
    console.error("Admin order error:", error);
    res.status(500).json({ success: false, message: "Failed to load order" });
  }
};
