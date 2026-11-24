import Razorpay from "razorpay";
import OrderModel from "../Model/OrderModel.js";
import ProductModel from "../Model/ProductModel.js";
import UserModel from "../Model/UserModel.js";
import SellerModel from "../Model/SellerModel.js";
import { invalidateCache } from "./cache.js";
import { sendOrderConfirmationEmail, sendSellerNewOrderEmail } from "./emailService.js";

let razorpayInstance = null;
/** Lazily create the Razorpay client so a missing key never crashes server start-up. */
export const getRazorpay = () => {
  if (razorpayInstance) return razorpayInstance;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(new Error("Online payments are not configured"), { status: 503 });
  }
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return razorpayInstance;
};

/**
 * Orders that are "real" for sellers / reports: cash on delivery, or online
 * orders whose payment actually went through.
 */
export const CONFIRMED_ORDER_FILTER = {
  $or: [
    { paymentMethod: "cod" },
    { paymentStatus: { $in: ["completed", "refunded", "partially_refunded"] } },
  ],
};

/** Legacy orders (created before this field existed) already had stock deducted. */
export const isInventoryCommitted = (order) => order.inventoryCommitted !== false;

export const restockItems = async (items, session) => {
  for (const item of items) {
    await ProductModel.updateOne(
      { _id: item.product },
      { $inc: { stock: item.quantity, soldCount: -item.quantity } },
      session ? { session } : {}
    );
  }
  invalidateCache();
};

/**
 * Commit an order exactly once: deduct stock, remove the purchased lines from
 * the shopper's cart, and send confirmation emails.
 * Safe to call repeatedly (verify endpoint + webhook can both fire).
 */
export const finalizeOrder = async (orderDocId) => {
  const order = await OrderModel.findOneAndUpdate(
    { _id: orderDocId, inventoryCommitted: false },
    { $set: { inventoryCommitted: true } },
    { new: true }
  );
  if (!order) return null; // already finalized

  const shortages = [];
  for (const item of order.items) {
    const result = await ProductModel.updateOne(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity, soldCount: item.quantity } }
    );
    if (result.modifiedCount === 0) {
      // Paid but stock ran out in the meantime - clamp to zero and flag for the seller.
      await ProductModel.updateOne(
        { _id: item.product },
        { $set: { stock: 0 }, $inc: { soldCount: item.quantity } }
      );
      shortages.push(item.product.toString());
    }
  }
  if (shortages.length) {
    order.notes = [order.notes, `Stock shortage on: ${shortages.join(", ")}`].filter(Boolean).join(" | ");
    await order.save();
    console.warn(`[order] ${order.orderId} finalized with stock shortages`, shortages);
  }
  invalidateCache();

  // Remove only the purchased products from the cart (shopper may have added more since).
  const user = await UserModel.findById(order.user);
  if (user) {
    const bought = new Set(
      order.items.map((i) => `${i.product}|${i.selectedColor || ""}|${i.selectedSize || ""}`)
    );
    user.cart = user.cart.filter(
      (c) => !bought.has(`${c.product}|${c.selectedColor || ""}|${c.selectedSize || ""}`)
    );
    if (!user.orders.some((o) => o.toString() === order._id.toString())) {
      user.orders.push(order._id);
    }
    await user.save();
  }

  // Emails are best-effort and never block the response.
  sendOrderEmails(order, user).catch((err) => console.error("[order] email error:", err.message));
  return order;
};

const sendOrderEmails = async (order, user) => {
  await order.populate([
    { path: "items.product", select: "name brand images" },
    { path: "items.seller", select: "name email phone" },
    { path: "sellerOrders.seller", select: "name email phone" },
  ]);

  const customerEmail = user?.email || order.shippingAddress?.email;
  if (customerEmail) await sendOrderConfirmationEmail(customerEmail, order);

  for (const sellerOrder of order.sellerOrders) {
    const sellerId = sellerOrder.seller?._id || sellerOrder.seller;
    const seller = sellerOrder.seller?.email ? sellerOrder.seller : await SellerModel.findById(sellerId);
    if (seller?.email) await sendSellerNewOrderEmail(seller.email, order, sellerOrder);
  }
};

/**
 * Initiate a Razorpay refund for `amount` (INR) if the order was paid online.
 * Never refunds more than what is left on the order.
 */
export const refundIfPaid = async (order, amount, notes = {}) => {
  if (order.paymentMethod !== "razorpay" || order.paymentStatus !== "completed" || !order.razorpayPaymentId) {
    return 0;
  }
  const alreadyRefunded = order.refundInitiatedAmount || 0;
  const refundable = Math.max(0, Math.round((order.total - alreadyRefunded) * 100) / 100);
  const toRefund = Math.min(Math.round(amount * 100) / 100, refundable);
  if (toRefund <= 0) return 0;

  try {
    await getRazorpay().payments.refund(order.razorpayPaymentId, {
      amount: Math.round(toRefund * 100),
      speed: "normal",
      notes: { orderId: order.orderId, ...notes },
    });
    await OrderModel.updateOne({ _id: order._id }, { $inc: { refundInitiatedAmount: toRefund } });
    order.refundInitiatedAmount = alreadyRefunded + toRefund;
    return toRefund;
  } catch (err) {
    console.error(`[refund] failed for order ${order.orderId}:`, err?.error?.description || err.message);
    return 0;
  }
};

/** Amount a shopper paid for given items, including their share of tax. */
export const itemsRefundValue = (items) =>
  items.reduce((sum, i) => sum + i.price * i.quantity * 1.18, 0);
