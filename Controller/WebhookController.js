import crypto from "crypto";
import OrderModel from "../Model/OrderModel.js";
import WebhookEventModel from "../Model/WebhookEventModel.js";

const SUPPORTED_EVENTS = new Set([
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.processed"
]);

const buildEventId = (event, payload) => {
  switch (event) {
    case "payment.captured":
    case "payment.failed":
      return payload?.payment?.entity?.id
        ? `${event}:${payload.payment.entity.id}`
        : null;
    case "order.paid":
      return payload?.order?.entity?.id
        ? `${event}:${payload.order.entity.id}`
        : null;
    case "refund.processed":
      return payload?.refund?.entity?.id
        ? `${event}:${payload.refund.entity.id}`
        : null;
    default:
      return null;
  }
};

const handlePaymentCaptured = async (payload) => {
  const paymentEntity = payload.payment.entity;
  const order = await OrderModel.findOne({ razorpayOrderId: paymentEntity.order_id });

  if (!order) {
    console.error(`[webhook] payment.captured: no order for razorpayOrderId ${paymentEntity.order_id}`);
    return;
  }

  if (order.paymentStatus === "completed") {
    console.log(`[webhook] order ${order.orderId} already completed, skipping`);
    return;
  }

  order.paymentStatus = "completed";
  order.razorpayPaymentId = paymentEntity.id;
  if (order.status === "pending") {
    order.status = "processing";
  }
  await order.save();

  console.log(`[webhook] order ${order.orderId} marked completed (payment.captured)`);
};

const handlePaymentFailed = async (payload) => {
  const paymentEntity = payload.payment.entity;
  const order = await OrderModel.findOne({ razorpayOrderId: paymentEntity.order_id });

  if (!order) {
    console.error(`[webhook] payment.failed: no order for razorpayOrderId ${paymentEntity.order_id}`);
    return;
  }

  if (order.paymentStatus === "completed") {
    console.log(`[webhook] order ${order.orderId} already completed, ignoring late payment.failed`);
    return;
  }

  order.paymentStatus = "failed";
  await order.save();

  console.log(`[webhook] order ${order.orderId} marked failed (payment.failed)`);
};

const handleOrderPaid = async (payload) => {
  const orderEntity = payload.order.entity;
  const order = await OrderModel.findOne({ razorpayOrderId: orderEntity.id });

  if (!order) {
    console.error(`[webhook] order.paid: no order for razorpayOrderId ${orderEntity.id}`);
    return;
  }

  if (order.paymentStatus === "completed") {
    return;
  }

  order.paymentStatus = "completed";
  if (order.status === "pending") {
    order.status = "processing";
  }
  await order.save();

  console.log(`[webhook] order ${order.orderId} marked completed (order.paid)`);
};

const handleRefundProcessed = async (payload) => {
  const refundEntity = payload.refund.entity;
  const order = await OrderModel.findOne({ razorpayPaymentId: refundEntity.payment_id });

  if (!order) {
    console.error(`[webhook] refund.processed: no order for razorpayPaymentId ${refundEntity.payment_id}`);
    return;
  }

  const refundAmount = refundEntity.amount / 100;
  order.refundAmount = (order.refundAmount || 0) + refundAmount;
  order.paymentStatus = order.refundAmount >= order.total ? "refunded" : "partially_refunded";
  await order.save();

  console.log(`[webhook] order ${order.orderId} refund recorded: ₹${refundAmount}`);
};

export const razorpayWebhook = async (req, res) => {
  try {
    const webhookSignature = req.headers["x-razorpay-signature"];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSignature || !webhookSecret) {
      console.error("[webhook] missing signature header or secret");
      return res.status(400).json({ success: false, message: "Missing signature" });
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error("[webhook] raw body not available - check app.js body-parser config");
      return res.status(400).json({ success: false, message: "Invalid request body" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature);
    const signatureBuffer = Buffer.from(webhookSignature);

    const isValidSignature =
      expectedBuffer.length === signatureBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

    if (!isValidSignature) {
      console.error("[webhook] invalid signature");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }

    const { event, payload } = req.body;

    if (!SUPPORTED_EVENTS.has(event)) {
      console.log(`[webhook] ignoring unsupported event: ${event}`);
      return res.status(200).json({ success: true, message: "Event ignored" });
    }

    const eventId = buildEventId(event, payload);
    if (!eventId) {
      console.warn(`[webhook] could not derive idempotency key for event: ${event}`);
      return res.status(200).json({ success: true, message: "Event ignored (no entity id)" });
    }

    try {
      await WebhookEventModel.create({ eventId, event });
    } catch (err) {
      if (err.code === 11000) {
        console.log(`[webhook] duplicate delivery for ${eventId}, skipping`);
        return res.status(200).json({ success: true, message: "Already processed" });
      }
      throw err;
    }

    switch (event) {
      case "payment.captured":
        await handlePaymentCaptured(payload);
        break;
      case "payment.failed":
        await handlePaymentFailed(payload);
        break;
      case "order.paid":
        await handleOrderPaid(payload);
        break;
      case "refund.processed":
        await handleRefundProcessed(payload);
        break;
    }

    return res.status(200).json({ success: true, message: "Webhook processed" });

  } catch (error) {
    console.error("[webhook] processing error:", error);
    return res.status(500).json({
      success: false,
      message: "Webhook processing failed",
      error: error.message
    });
  }
};