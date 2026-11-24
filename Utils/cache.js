// Small in-process TTL cache for public catalog reads.
// Any write to products / categories / sellers must call invalidateCache()
// so shoppers never see stale prices or stock.

const cache = new Map();
const DEFAULT_TTL = 2 * 60 * 1000;
const MAX_ENTRIES = 1000;

export const getFromCache = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
};

export const setToCache = (key, data, ttl = DEFAULT_TTL) => {
  if (cache.size >= MAX_ENTRIES) {
    // drop the oldest entry (Map keeps insertion order)
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { data, expires: Date.now() + ttl });
};

export const invalidateCache = (keyPattern = "") => {
  if (!keyPattern) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.includes(keyPattern)) cache.delete(key);
  }
};
