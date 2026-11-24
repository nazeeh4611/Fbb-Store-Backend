import mongoose from "mongoose";
import UserModel from "../Model/UserModel.js";
import ProductModel from "../Model/ProductModel.js";
import { getUnitPriceINR, getLineShipping, computeTotals } from "../Utils/pricing.js";

const CART_PRODUCT_FIELDS =
  "name brand priceINR priceAED images stock colors sizes active deleted seller shippingInfo discount";

const CART_POPULATE = {
  path: "cart.product",
  select: CART_PRODUCT_FIELDS,
  populate: { path: "seller", select: "name companyName phone email city state country" },
};

const WISHLIST_POPULATE = {
  path: "wishlist.product",
  select: "name brand priceINR priceAED images stock active deleted discount",
};

const isId = (id) => mongoose.Types.ObjectId.isValid(id);

const toQuantity = (value, fallback = 1) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const getUser = async (req) => {
  const user = await UserModel.findById(req.user._id);
  if (!user) throw Object.assign(new Error("User not found"), { status: 401 });
  return user;
};

const isAvailable = (product) => product && product.active && !product.deleted;

/**
 * Populate the cart, drop products that no longer exist / are inactive,
 * and refresh each line's price to the current (discounted) price.
 */
const loadCart = async (user) => {
  await user.populate(CART_POPULATE);
  let changed = false;

  const valid = user.cart.filter((item) => isAvailable(item.product));
  if (valid.length !== user.cart.length) {
    user.cart = valid;
    changed = true;
  }

  for (const item of user.cart) {
    const current = getUnitPriceINR(item.product);
    if (item.price !== current) {
      item.price = current;
      changed = true;
    }
  }

  if (changed) {
    await user.save();
    await user.populate(CART_POPULATE);
  }
  return user.cart;
};

const buildSummary = (cart) => {
  const totals = computeTotals(cart);
  const bySeller = new Map();

  for (const item of cart) {
    const seller = item.product.seller;
    const sellerId = (seller?._id || seller || "unknown").toString();
    if (!bySeller.has(sellerId)) {
      bySeller.set(sellerId, { seller, items: [], subtotal: 0, shipping: 0, itemsCount: 0 });
    }
    const group = bySeller.get(sellerId);
    group.items.push({
      id: item._id,
      productId: item.product._id,
      name: item.product.name,
      brand: item.product.brand,
      quantity: item.quantity,
      price: item.price,
      image: item.product.images?.image1,
      images: item.product.images,
      stock: item.product.stock,
      selectedColor: item.selectedColor,
      selectedSize: item.selectedSize,
    });
    group.subtotal += item.price * item.quantity;
    group.shipping += getLineShipping(item.product);
    group.itemsCount += item.quantity;
  }

  return {
    ...totals,
    sellers: Array.from(bySeller.values()),
  };
};

const cartResponse = (cart, message) => {
  const summary = buildSummary(cart);
  return {
    success: true,
    ...(message ? { message } : {}),
    cart,
    cartCount: summary.items,
    cartTotal: summary.subtotal,
    summary,
  };
};

const fail = (res, error, fallback) => {
  if (error.status) return res.status(error.status).json({ success: false, message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
};

/* ------------------------------------------------------------------ cart */

export const addToCart = async (req, res) => {
  try {
    const { productId, color, size } = req.body;
    const quantity = toQuantity(req.body.quantity, 1);

    if (!productId || !isId(productId)) {
      return res.status(400).json({ success: false, message: "A valid product is required" });
    }
    if (quantity < 1 || quantity > 100) {
      return res.status(400).json({ success: false, message: "Quantity must be between 1 and 100" });
    }

    const product = await ProductModel.findById(productId).select(CART_PRODUCT_FIELDS);
    if (!isAvailable(product)) {
      return res.status(404).json({ success: false, message: "Product not available" });
    }
    if (product.colors?.length && color && !product.colors.includes(color)) {
      return res.status(400).json({ success: false, message: "Selected color is not available" });
    }
    if (product.sizes?.length && size && !product.sizes.includes(size)) {
      return res.status(400).json({ success: false, message: "Selected size is not available" });
    }

    const user = await getUser(req);
    const existing = user.cart.find(
      (item) =>
        item.product.toString() === productId &&
        (item.selectedColor || "") === (color || "") &&
        (item.selectedSize || "") === (size || "")
    );

    const newQuantity = (existing?.quantity || 0) + quantity;
    if (product.stock < newQuantity) {
      return res.status(400).json({
        success: false,
        message: product.stock > 0 ? `Only ${product.stock} left in stock` : "This product is out of stock",
        availableStock: product.stock,
      });
    }

    if (existing) {
      existing.quantity = newQuantity;
      existing.price = getUnitPriceINR(product);
    } else {
      user.cart.push({
        product: productId,
        quantity,
        selectedColor: color || undefined,
        selectedSize: size || undefined,
        price: getUnitPriceINR(product),
      });
    }

    await user.save();
    const cart = await loadCart(user);
    res.status(200).json(cartResponse(cart, "Product added to cart"));
  } catch (error) {
    fail(res, error, "Failed to add to cart");
  }
};

export const updateCartItem = async (req, res) => {
  try {
    const { cartItemId } = req.body;
    const quantity = toQuantity(req.body.quantity, NaN);

    if (!cartItemId || !Number.isFinite(quantity) || quantity < 0 || quantity > 100) {
      return res.status(400).json({ success: false, message: "Valid cart item and quantity are required" });
    }

    const user = await getUser(req);
    const cartItem = user.cart.id(cartItemId);
    if (!cartItem) {
      return res.status(404).json({ success: false, message: "Cart item not found" });
    }

    if (quantity === 0) {
      cartItem.deleteOne();
    } else {
      const product = await ProductModel.findById(cartItem.product).select("stock active deleted");
      if (!isAvailable(product)) {
        cartItem.deleteOne();
        await user.save();
        return res.status(404).json({ success: false, message: "Product is no longer available" });
      }
      if (product.stock < quantity) {
        return res.status(400).json({
          success: false,
          message: `Only ${product.stock} left in stock`,
          availableStock: product.stock,
        });
      }
      cartItem.quantity = quantity;
    }

    await user.save();
    const cart = await loadCart(user);
    res.status(200).json(cartResponse(cart, "Cart updated"));
  } catch (error) {
    fail(res, error, "Failed to update cart");
  }
};

export const removeFromCart = async (req, res) => {
  try {
    const { cartItemId } = req.params;
    const user = await getUser(req);

    const cartItem = user.cart.id(cartItemId);
    if (cartItem) {
      cartItem.deleteOne();
      await user.save();
    }

    const cart = await loadCart(user);
    res.status(200).json(cartResponse(cart, "Item removed from cart"));
  } catch (error) {
    fail(res, error, "Failed to remove from cart");
  }
};

export const clearCart = async (req, res) => {
  try {
    await UserModel.updateOne({ _id: req.user._id }, { $set: { cart: [] } });
    res.status(200).json(cartResponse([], "Cart cleared"));
  } catch (error) {
    fail(res, error, "Failed to clear cart");
  }
};

export const getCart = async (req, res) => {
  try {
    const user = await getUser(req);
    const cart = await loadCart(user);
    const response = cartResponse(cart);
    res.status(200).json({ ...response, cartBySeller: response.summary.sellers });
  } catch (error) {
    fail(res, error, "Failed to get cart");
  }
};

export const getCartBySeller = getCart;

export const getCartSummary = async (req, res) => {
  try {
    const user = await getUser(req);
    const cart = await loadCart(user);
    res.status(200).json({ success: true, summary: buildSummary(cart) });
  } catch (error) {
    fail(res, error, "Failed to get cart summary");
  }
};

/* -------------------------------------------------------------- wishlist */

const wishlistResponse = async (user, message) => {
  await user.populate(WISHLIST_POPULATE);
  const valid = user.wishlist.filter((w) => isAvailable(w.product));
  if (valid.length !== user.wishlist.length) {
    user.wishlist = valid;
    await user.save();
    await user.populate(WISHLIST_POPULATE);
  }
  return {
    success: true,
    ...(message ? { message } : {}),
    wishlist: user.wishlist,
    wishlistCount: user.wishlist.length,
  };
};

export const addToWishlist = async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId || !isId(productId)) {
      return res.status(400).json({ success: false, message: "A valid product is required" });
    }

    const product = await ProductModel.findById(productId).select("active deleted");
    if (!isAvailable(product)) {
      return res.status(404).json({ success: false, message: "Product not available" });
    }

    const user = await getUser(req);
    const already = user.wishlist.some((w) => w.product.toString() === productId);
    if (!already) {
      user.wishlist.push({ product: productId });
      await user.save();
    }

    res.status(200).json(await wishlistResponse(user, already ? "Product already in wishlist" : "Product added to wishlist"));
  } catch (error) {
    fail(res, error, "Failed to add to wishlist");
  }
};

export const removeFromWishlist = async (req, res) => {
  try {
    const { productId } = req.params;
    const user = await getUser(req);

    const before = user.wishlist.length;
    user.wishlist = user.wishlist.filter((w) => w.product.toString() !== productId);
    if (user.wishlist.length !== before) await user.save();

    res.status(200).json(await wishlistResponse(user, "Product removed from wishlist"));
  } catch (error) {
    fail(res, error, "Failed to remove from wishlist");
  }
};

export const getWishlist = async (req, res) => {
  try {
    const user = await getUser(req);
    res.status(200).json(await wishlistResponse(user));
  } catch (error) {
    fail(res, error, "Failed to get wishlist");
  }
};

export const moveToCart = async (req, res) => {
  try {
    const { productId, color, size } = req.body;
    const quantity = Math.max(1, toQuantity(req.body.quantity, 1));

    if (!productId || !isId(productId)) {
      return res.status(400).json({ success: false, message: "A valid product is required" });
    }

    const product = await ProductModel.findById(productId).select(CART_PRODUCT_FIELDS);
    if (!isAvailable(product)) {
      return res.status(404).json({ success: false, message: "Product not available" });
    }

    const user = await getUser(req);
    // Default to the first variant when moving from the wishlist without a selection.
    const selectedColor = color || product.colors?.[0] || undefined;
    const selectedSize = size || product.sizes?.[0] || undefined;

    const existing = user.cart.find(
      (item) =>
        item.product.toString() === productId &&
        (item.selectedColor || "") === (selectedColor || "") &&
        (item.selectedSize || "") === (selectedSize || "")
    );
    const newQuantity = (existing?.quantity || 0) + quantity;
    if (product.stock < newQuantity) {
      return res.status(400).json({
        success: false,
        message: product.stock > 0 ? `Only ${product.stock} left in stock` : "This product is out of stock",
        availableStock: product.stock,
      });
    }

    if (existing) existing.quantity = newQuantity;
    else {
      user.cart.push({
        product: productId,
        quantity,
        selectedColor,
        selectedSize,
        price: getUnitPriceINR(product),
      });
    }
    user.wishlist = user.wishlist.filter((w) => w.product.toString() !== productId);
    await user.save();

    const cart = await loadCart(user);
    const wishlist = await wishlistResponse(user);
    res.status(200).json({
      ...cartResponse(cart, "Product moved to cart"),
      wishlist: wishlist.wishlist,
      wishlistCount: wishlist.wishlistCount,
    });
  } catch (error) {
    fail(res, error, "Failed to move product to cart");
  }
};
