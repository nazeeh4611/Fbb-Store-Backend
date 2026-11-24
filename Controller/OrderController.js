import OrderModel from "../Model/OrderModel.js";
import ProductModel from "../Model/ProductModel.js";
import UserModel from "../Model/UserModel.js";
import mongoose from "mongoose";
import crypto from "crypto";
import { getUnitPriceINR, getLineShipping, computeTax } from "../Utils/pricing.js";
import {
  getRazorpay,
  finalizeOrder,
  restockItems,
  refundIfPaid,
  itemsRefundValue,
  isInventoryCommitted,
  CONFIRMED_ORDER_FILTER,
} from "../Utils/orderService.js";

const generateOrderId = () => `ORD${Date.now()}${crypto.randomInt(1000, 9999)}`;

const ADDRESS_FIELDS = ["name", "phone", "email", "street", "city", "state", "country", "pincode"];
const cleanAddress = (addr) => {
  if (!addr || typeof addr !== "object") return null;
  const out = {};
  for (const f of ADDRESS_FIELDS) {
    if (addr[f] !== undefined && addr[f] !== null) out[f] = String(addr[f]).trim().slice(0, 300);
  }
  return out;
};
const REQUIRED_ADDRESS = ["name", "phone", "street", "city", "state", "pincode"];

export const createOrder = async (req, res) => {
  const { shippingAddress: rawShipping, billingAddress: rawBilling, paymentMethod, notes } = req.body;

  if (!["razorpay", "cod"].includes(paymentMethod)) {
    return res.status(400).json({ success: false, message: "Invalid payment method" });
  }
  const shippingAddress = cleanAddress(rawShipping);
  const missing = REQUIRED_ADDRESS.filter((f) => !shippingAddress?.[f]);
  if (missing.length) {
    return res.status(400).json({ success: false, message: `Shipping address is missing: ${missing.join(", ")}` });
  }
  if (!/^[0-9+\-\s]{7,15}$/.test(shippingAddress.phone)) {
    return res.status(400).json({ success: false, message: "Please enter a valid phone number" });
  }
  const billingAddress = cleanAddress(rawBilling) || shippingAddress;

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const userId = req.user._id;
    const user = await UserModel.findById(userId).session(session);
    if (!shippingAddress.email && user.email) shippingAddress.email = user.email;

    if (!user.cart.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    const orderItems = [];
    const sellerItemsMap = new Map();
    const unavailable = [];
    let subtotal = 0;
    let shipping = 0;

    for (const cartItem of user.cart) {
      const product = await ProductModel.findById(cartItem.product).session(session);

      if (!product || !product.active || product.deleted) {
        unavailable.push({ product: product?.name || "A product in your cart", reason: "No longer available" });
        continue;
      }
      if (product.stock < cartItem.quantity) {
        unavailable.push({
          product: product.name,
          reason: product.stock > 0 ? `Only ${product.stock} left in stock` : "Out of stock",
        });
        continue;
      }

      // Always charge the CURRENT price (with any active discount), never the price saved in the cart.
      const unitPrice = getUnitPriceINR(product);
      const lineSubtotal = unitPrice * cartItem.quantity;
      const lineShipping = getLineShipping(product);

      const orderItem = {
        product: product._id,
        seller: product.seller,
        quantity: cartItem.quantity,
        price: unitPrice,
        selectedColor: cartItem.selectedColor,
        selectedSize: cartItem.selectedSize,
        itemStatus: "pending",
        sellerStatus: "pending",
      };
      orderItems.push(orderItem);

      const sellerId = product.seller.toString();
      if (!sellerItemsMap.has(sellerId)) {
        sellerItemsMap.set(sellerId, { seller: product.seller, items: [], subtotal: 0, shipping: 0, tax: 0, total: 0 });
      }
      const sellerOrder = sellerItemsMap.get(sellerId);
      sellerOrder.items.push(orderItem);
      sellerOrder.subtotal += lineSubtotal;
      sellerOrder.shipping += lineShipping;

      subtotal += lineSubtotal;
      shipping += lineShipping;
    }

    if (unavailable.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Some items are unavailable: ${unavailable.map((u) => `${u.product} (${u.reason})`).join(", ")}`,
        unavailableItems: unavailable,
      });
    }

    subtotal = Math.round(subtotal * 100) / 100;
    const tax = computeTax(subtotal);
    const total = Math.round((subtotal + shipping + tax) * 100) / 100;

    sellerItemsMap.forEach((so) => {
      so.subtotal = Math.round(so.subtotal * 100) / 100;
      so.tax = computeTax(so.subtotal);
      so.total = Math.round((so.subtotal + so.shipping + so.tax) * 100) / 100;
    });

    const order = new OrderModel({
      orderId: generateOrderId(),
      user: userId,
      items: orderItems,
      sellerOrders: Array.from(sellerItemsMap.values()),
      shippingAddress,
      billingAddress,
      paymentMethod,
      paymentStatus: "pending",
      subtotal,
      shipping,
      tax,
      total,
      status: "pending",
      notes: typeof notes === "string" ? notes.slice(0, 500) : undefined,
      inventoryCommitted: false,
    });

    // Create the Razorpay order BEFORE committing so a gateway failure leaves nothing behind.
    let razorpayOrder = null;
    if (paymentMethod === "razorpay") {
      razorpayOrder = await getRazorpay().orders.create({
        amount: Math.round(total * 100),
        currency: "INR",
        receipt: order.orderId,
        notes: { orderId: order.orderId, userId: userId.toString() },
      });
      order.razorpayOrderId = razorpayOrder.id;
    }

    await order.save({ session });
    await session.commitTransaction();

    // COD orders are confirmed immediately; online orders are finalized after payment.
    if (paymentMethod === "cod") {
      await finalizeOrder(order._id);
    }

    await order.populate([
      { path: "items.product", select: "name brand images" },
      { path: "items.seller", select: "name" },
    ]);

    return res.status(200).json({
      success: true,
      message: paymentMethod === "cod" ? "Order placed successfully. Pay on delivery." : "Order created successfully",
      order,
      razorpayOrder,
      key_id: paymentMethod === "razorpay" ? process.env.RAZORPAY_KEY_ID : undefined,
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("Error creating order:", error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : "Failed to create order. Please try again.",
    });
  } finally {
    session.endSession();
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      return res.status(400).json({ success: false, message: "Missing payment details" });
    }

    const order = await OrderModel.findOne({ orderId, user: req.user._id });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // The signature must belong to THIS order's Razorpay order, otherwise a
    // payment for a cheap order could be replayed against an expensive one.
    if (order.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ success: false, message: "Payment does not match this order" });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const a = Buffer.from(generatedSignature);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    if (order.paymentStatus !== "completed") {
      order.paymentStatus = "completed";
      order.razorpayPaymentId = razorpay_payment_id;
      order.razorpaySignature = razorpay_signature;
      if (order.status === "pending") order.status = "processing";
      await order.save();
    }

    await finalizeOrder(order._id);

    return res.status(200).json({ success: true, message: "Payment verified successfully", order });
  } catch (error) {
    console.error("Error verifying payment:", error);
    return res.status(500).json({ success: false, message: "Payment verification failed" });
  }
};

export const getOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user._id;

    const order = await OrderModel.findOne({ 
      orderId,
      user: userId 
    })
    .populate({
      path: 'items.product',
      select: 'name brand images'
    })
    .populate({
      path: 'items.seller',
      select: 'name companyName phone email'
    })
    .populate({
      path: 'sellerOrders.seller',
      select: 'name companyName phone email'
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    res.status(200).json({
      success: true,
      order: order
    });

  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).json({
      success: false,
      message: "Failed to get order"
    });
  }
};

export const getUserOrders = async (req, res) => {
  try {
    const userId = req.user._id;

    const orders = await OrderModel.find({ user: userId, ...CONFIRMED_ORDER_FILTER })
      .sort({ createdAt: -1 })
      .populate({
        path: 'items.product',
        select: 'name brand images priceINR priceAED'
      })
      .populate({
        path: 'items.seller',
        select: 'name companyName'
      })
      .populate({
        path: 'sellerOrders.seller',
        select: 'name companyName'
      });

    const formattedOrders = orders.map(order => ({
      _id: order._id,
      orderId: order.orderId,
      createdAt: order.createdAt,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      total: order.total,
      subtotal: order.subtotal,
      shipping: order.shipping,
      tax: order.tax,
      itemsCount: order.items?.length || 0,
      items: order.items?.map(item => ({
        _id: item._id,
        product: item.product
          ? {
              _id: item.product._id,
              name: item.product.name,
              brand: item.product.brand,
              images: item.product.images,
              priceINR: item.product.priceINR,
              priceAED: item.product.priceAED
            }
          : null,
        quantity: item.quantity,
        price: item.price,
        selectedColor: item.selectedColor,
        selectedSize: item.selectedSize,
        itemStatus: item.itemStatus,
        sellerStatus: item.sellerStatus,
        cancellationReason: item.cancellationReason,
        returnStatus: item.returnStatus,
        returnReason: item.returnReason
      })) || [],
      sellers: order.sellerOrders?.map(so => ({
        name: so.seller?.name || "Unknown Seller",
        status: so.sellerStatus || "pending"
      })) || [],
      shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress
    }));

    res.status(200).json({
      success: true,
      orders: formattedOrders,
      count: formattedOrders.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get orders"
    });
  }
};

export const getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user._id;

    const order = await OrderModel.findOne({ 
      orderId,
      user: userId 
    })
    .populate([
      {
        path: 'items.product',
        select: 'name brand images description priceINR priceAED stock'
      },
      {
        path: 'items.seller',
        select: 'name companyName phone email address'
      },
      {
        path: 'sellerOrders.seller',
        select: 'name companyName phone email'
      }
    ]);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    const orderBySeller = {};
    order.sellerOrders.forEach(sellerOrder => {
      const sellerId = (sellerOrder.seller?._id || sellerOrder.seller)?.toString();
      if (!sellerId) return;
      orderBySeller[sellerId] = {
        seller: sellerOrder.seller,
        items: order.items.filter(item =>
          (item.seller?._id || item.seller)?.toString() === sellerId
        ),
        subtotal: sellerOrder.subtotal,
        shipping: sellerOrder.shipping,
        tax: sellerOrder.tax,
        total: sellerOrder.total,
        status: sellerOrder.sellerStatus,
        trackingNumber: sellerOrder.trackingNumber,
        shippedAt: sellerOrder.shippedAt
      };
    });

    const responseData = {
      ...order.toObject(),
      items: order.items.map(item => ({
        ...item.toObject(),
        canCancel: ["pending", "processing"].includes(item.itemStatus),
        canReturn: item.itemStatus === "delivered" && !item.returnStatus
      })),
      orderBySeller: Object.values(orderBySeller)
    };

    res.status(200).json({
      success: true,
      order: responseData
    });

  } catch (error) {
    console.error('Error getting order details:', error);
    res.status(500).json({
      success: false,
      message: "Failed to get order details"
    });
  }
};

export const cancelOrderItem = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { itemId, reason } = req.body;

    const order = await OrderModel.findOne({ orderId, user: req.user._id });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const orderItem = order.items.id(itemId);
    if (!orderItem) {
      return res.status(404).json({ success: false, message: "Order item not found" });
    }
    if (!["pending", "processing", "accepted"].includes(orderItem.itemStatus)) {
      return res.status(400).json({ success: false, message: "Item cannot be cancelled at this stage" });
    }

    orderItem.itemStatus = "cancelled";
    orderItem.sellerStatus = "cancelled";
    orderItem.cancellationReason = reason;

    if (order.items.every((i) => i.itemStatus === "cancelled")) {
      order.status = "cancelled";
      order.cancellationReason = reason;
    }
    await order.save();

    if (isInventoryCommitted(order)) await restockItems([orderItem]);

    // Last item cancelled -> refund whatever is left (includes shipping); otherwise just this item.
    const refundAmount = order.status === "cancelled" ? order.total : itemsRefundValue([orderItem]);
    await refundIfPaid(order, refundAmount, { itemId: String(itemId) });

    await order.populate([
      { path: "items.product", select: "name brand images" },
      { path: "items.seller", select: "name companyName" },
    ]);

    res.status(200).json({ success: true, message: "Item cancelled successfully", order });
  } catch (error) {
    console.error("Error cancelling order item:", error);
    res.status(500).json({ success: false, message: "Failed to cancel item" });
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await OrderModel.findOne({ orderId, user: req.user._id });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (!["pending", "processing", "accepted"].includes(order.status)) {
      return res.status(400).json({ success: false, message: "Order cannot be cancelled at this stage" });
    }

    const cancelled = [];
    for (const item of order.items) {
      if (["pending", "processing", "accepted"].includes(item.itemStatus)) {
        item.itemStatus = "cancelled";
        item.sellerStatus = "cancelled";
        item.cancellationReason = reason;
        cancelled.push(item);
      }
    }
    order.status = "cancelled";
    order.cancellationReason = reason;
    order.sellerOrders.forEach((so) => {
      so.sellerStatus = "cancelled";
    });
    await order.save();

    if (isInventoryCommitted(order)) await restockItems(cancelled);
    await refundIfPaid(order, order.total);

    await order.populate([
      { path: "items.product", select: "name brand images" },
      { path: "items.seller", select: "name companyName" },
    ]);

    res.status(200).json({ success: true, message: "Order cancelled successfully", order });
  } catch (error) {
    console.error("Error cancelling order:", error);
    res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
};

export const requestReturn = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { itemId, reason } = req.body;
    const userId = req.user._id;

    const order = await OrderModel.findOne({ 
      orderId,
      user: userId 
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    const orderItem = order.items.id(itemId);
    if (!orderItem) {
      return res.status(404).json({
        success: false,
        message: "Order item not found"
      });
    }

    if (orderItem.itemStatus !== "delivered") {
      return res.status(400).json({
        success: false,
        message: "Only delivered items can be returned"
      });
    }

    if (orderItem.returnStatus) {
      return res.status(400).json({
        success: false,
        message: "Return already requested for this item"
      });
    }

    const deliveredDate = orderItem.actualDeliveryDate || order.updatedAt;
    const daysSinceDelivery = Math.floor((new Date() - new Date(deliveredDate)) / (1000 * 60 * 60 * 24));

    if (daysSinceDelivery > 30) {
      return res.status(400).json({
        success: false,
        message: "Return window has expired (30 days)"
      });
    }

    orderItem.returnStatus = "requested";
    orderItem.returnReason = reason;

    const hasAnyReturn = order.items.some(item => item.returnStatus);
    if (hasAnyReturn) {
      order.status = "returned";
    }

    await order.save();

    await order.populate([
      { path: 'items.product', select: 'name brand images' },
      { path: 'items.seller', select: 'name companyName' }
    ]);

    res.status(200).json({
      success: true,
      message: "Return requested successfully",
      order: order
    });

  } catch (error) {
    console.error('Error requesting return:', error);
    res.status(500).json({
      success: false,
      message: "Failed to request return"
    });
  }
};

export const trackOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user._id;

    const order = await OrderModel.findOne({ 
      orderId,
      user: userId 
    })
    .populate({
      path: 'items.product',
      select: 'name brand images'
    })
    .populate({
      path: 'items.seller',
      select: 'name phone email'
    })
    .populate({
      path: 'sellerOrders.seller',
      select: 'name'
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    const trackingInfo = {
      orderId: order.orderId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      createdAt: order.createdAt,
      estimatedDelivery: order.items[0]?.estimatedDeliveryDate,
      shippingAddress: order.shippingAddress,
      items: order.items.map(item => ({
        product: item.product,
        seller: item.seller,
        quantity: item.quantity,
        status: item.itemStatus,
        trackingNumber: item.trackingNumber,
        shippingProvider: item.shippingProvider,
        estimatedDelivery: item.estimatedDeliveryDate,
        actualDeliveryDate: item.actualDeliveryDate
      })),
      sellerOrders: order.sellerOrders.map(so => ({
        seller: so.seller,
        status: so.sellerStatus,
        trackingNumber: so.trackingNumber,
        shippedAt: so.shippedAt
      }))
    };

    res.status(200).json({
      success: true,
      tracking: trackingInfo
    });

  } catch (error) {
    console.error('Error tracking order:', error);
    res.status(500).json({
      success: false,
      message: "Failed to track order"
    });
  }
};

export const getSalesReport = async (req, res) => {
  try {
    const sellerId = req.seller._id;
    const sellerIdStr = sellerId.toString();
    const { range } = req.query;

    const startDate = new Date();
    const endDate = new Date();
    if (range === "week") startDate.setDate(startDate.getDate() - 7);
    else if (range === "quarter") startDate.setMonth(startDate.getMonth() - 3);
    else if (range === "year") startDate.setFullYear(startDate.getFullYear() - 1);
    else startDate.setMonth(startDate.getMonth() - 1);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    // Previous period of equal length, for the growth rate.
    const periodMs = endDate - startDate;
    const prevStart = new Date(startDate.getTime() - periodMs);

    const orders = await OrderModel.find({
      "items.seller": sellerId,
      createdAt: { $gte: prevStart, $lte: endDate },
      ...CONFIRMED_ORDER_FILTER,
    })
      .select("items createdAt")
      .populate({ path: "items.product", select: "categoryId", populate: { path: "categoryId", select: "name" } })
      .lean();

    let totalSales = 0;
    let prevSales = 0;
    let totalOrders = 0;
    let totalProducts = 0;
    const salesMap = new Map();
    const categoryMap = new Map();

    for (const order of orders) {
      const inCurrent = order.createdAt >= startDate;
      const mine = order.items.filter(
        (i) => i.seller?.toString() === sellerIdStr && i.itemStatus !== "cancelled"
      );
      if (!mine.length) continue;

      const orderSales = mine.reduce((sum, i) => sum + i.price * i.quantity, 0);
      if (!inCurrent) {
        prevSales += orderSales;
        continue;
      }

      totalOrders++;
      totalSales += orderSales;
      const dateStr = order.createdAt.toISOString().split("T")[0];
      const day = salesMap.get(dateStr) || { sales: 0, orders: 0 };
      day.sales += orderSales;
      day.orders += 1;
      salesMap.set(dateStr, day);

      for (const item of mine) {
        totalProducts += item.quantity;
        const name = item.product?.categoryId?.name || "Others";
        categoryMap.set(name, (categoryMap.get(name) || 0) + item.price * item.quantity);
      }
    }

    const salesData = Array.from(salesMap.entries())
      .map(([date, d]) => ({ date, sales: Number(d.sales.toFixed(2)), orders: d.orders }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const categoryData = Array.from(categoryMap.entries())
      .map(([name, value]) => ({ name, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;
    const growthRate = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : totalSales > 0 ? 100 : 0;

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalSales: Number(totalSales.toFixed(2)),
          totalOrders,
          totalProducts,
          avgOrderValue: Number(avgOrderValue.toFixed(2)),
          growthRate: Number(growthRate.toFixed(1)),
        },
        salesData,
        categoryData,
        monthlyTrends: [],
      },
    });
  } catch (error) {
    console.error("Sales report error:", error);
    res.status(500).json({ success: false, message: "Failed to load sales report" });
  }
};
