import Stripe from 'stripe';

// Upgrading the SDK must not silently upgrade the API contract used by the
// reconciliation client. stripe@17.7.0 used this Acacia API version.
const STRIPE_API_VERSION = '2025-02-24.acacia';

let cachedClient = null;
let cachedKey = null;

/**
 * Lazily construct the Stripe SDK client from STRIPE_SECRET_KEY. Throws instead
 * of using the offline verifier's placeholder key because every call here hits
 * the real Stripe API.
 */
const getClient = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is required to contact Stripe.');
  }
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
    cachedKey = key;
  }
  return cachedClient;
};

/** Retrieve a single PaymentIntent by id. */
export async function retrievePaymentIntent(id) {
  return getClient().paymentIntents.retrieve(id);
}

/**
 * List PaymentIntents, optionally created at or after `since` (a Date), capped
 * at `limit`. Returns a single page — callers needing more than one page should
 * bound their query window instead of paginating.
 */
export async function listPaymentIntents({ since = null, limit = 100 } = {}) {
  const params = { limit };
  if (since instanceof Date) {
    params.created = { gte: Math.floor(since.getTime() / 1000) };
  }
  const result = await getClient().paymentIntents.list(params);
  return result.data;
}

export default { retrievePaymentIntent, listPaymentIntents };
