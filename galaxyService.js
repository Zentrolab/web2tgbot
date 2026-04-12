/**
 * Galaxy Payment Service — Direct API Integration
 * Calls Galaxy Payment gateway directly (no Laravel proxy needed)
 *
 * Endpoints:
 *   POST /api/me      — Merchant balance
 *   POST /api/daifu   — Withdrawal / Payout
 *   POST /api/query   — Transaction query
 */

const axios = require("axios");
const crypto = require("crypto");
const https = require("https");

const httpsAgent = new https.Agent({ keepAlive: true });

// Read config from env
const MERCHANT_ID = process.env.GALAXY_MERCHANT_ID;
const SECRET_KEY = process.env.GALAXY_SECRET_KEY;
const BALANCE_URL = process.env.GALAXY_BALANCE_URL; // https://cloud.la2568.site/api/me
const WITHDRAWAL_URL = process.env.GALAXY_WITHDRAWAL_URL; // https://cloud.la2568.site/api/daifu
const QUERY_URL = process.env.GALAXY_QUERY_URL; // https://cloud.la2568.site/api/query

/**
 * Generate MD5 signature per Galaxy API docs:
 * 1. Remove empty values and 'sign' key
 * 2. Sort params by key in ASCII ascending order
 * 3. Concatenate as k1=v1&k2=v2
 * 4. Append &key=secret_key
 * 5. MD5 hash the result
 */
const generateSign = (params) => {
  const filtered = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "sign" && value !== "" && value !== null && value !== undefined) {
      filtered[key] = value;
    }
  }

  const sorted = Object.keys(filtered).sort();
  const parts = sorted.map((key) => `${key}=${filtered[key]}`);
  const signStr = parts.join("&") + `&key=${SECRET_KEY}`;

  return crypto.createHash("md5").update(signStr).digest("hex");
};

/**
 * POST helper for Galaxy API
 */
const galaxyPost = async (url, params) => {
  params.sign = generateSign(params);

  const response = await axios.post(url, new URLSearchParams(params).toString(), {
    httpsAgent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  return response.data;
};

/**
 * Get merchant balance
 * Galaxy POST /api/me
 * Returns: { merchant, merchant_display_name, balance, pending_balance, sign }
 */
const getBalance = async () => {
  if (!MERCHANT_ID || !SECRET_KEY || !BALANCE_URL) {
    return { success: false, error: "Galaxy credentials not configured in .env" };
  }

  try {
    const data = await galaxyPost(BALANCE_URL, { merchant: MERCHANT_ID });
    const balance = parseFloat(data.balance) || 0;
    const pending = parseFloat(data.pending_balance) || 0;

    return {
      success: true,
      balance,
      pending,
      merchant: data.merchant || MERCHANT_ID,
      merchant_display_name: data.merchant_display_name || "",
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response ? err.response.data : err.message,
    };
  }
};

/**
 * Initiate withdrawal / payout
 * Galaxy POST /api/daifu
 *
 * @param {Object} opts
 * @param {number} opts.amount
 * @param {string} opts.orderId
 * @param {string} opts.bank          — e.g. "maya2", "gcash"
 * @param {string} opts.bankCardName  — account holder name
 * @param {string} opts.bankCardAccount — account number
 * @param {string} opts.bankCardRemark  — optional remark
 * @param {string} opts.callbackUrl   — URL Galaxy calls on completion
 */
const initiateWithdrawal = async (opts) => {
  if (!MERCHANT_ID || !SECRET_KEY || !WITHDRAWAL_URL) {
    return { success: false, error: "Galaxy credentials not configured in .env" };
  }

  try {
    const amount = opts.amount;
    const amountStr = Number.isInteger(amount) ? String(amount) : String(amount);

    const params = {
      merchant: MERCHANT_ID,
      total_amount: amountStr,
      callback_url: opts.callbackUrl,
      order_id: opts.orderId,
      bank: opts.bank,
      bank_card_name: opts.bankCardName,
      bank_card_account: opts.bankCardAccount,
      bank_card_remark: opts.bankCardRemark || "",
    };

    const data = await galaxyPost(WITHDRAWAL_URL, params);
    const status = String(data.status || "0");

    return {
      success: status === "1",
      status,
      message: data.message || "",
      orderId: opts.orderId,
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response ? err.response.data : err.message,
    };
  }
};

/**
 * Query a transaction status
 * Galaxy POST /api/query
 */
const queryTransaction = async (orderId) => {
  if (!MERCHANT_ID || !SECRET_KEY || !QUERY_URL) {
    return { success: false, error: "Galaxy credentials not configured in .env" };
  }

  try {
    const data = await galaxyPost(QUERY_URL, {
      merchant: MERCHANT_ID,
      order_id: orderId,
    });

    return { success: true, raw: data };
  } catch (err) {
    return {
      success: false,
      error: err.response ? err.response.data : err.message,
    };
  }
};

/**
 * Check if Galaxy is configured
 */
const isConfigured = () => {
  return !!(MERCHANT_ID && SECRET_KEY && BALANCE_URL && WITHDRAWAL_URL);
};

module.exports = {
  getBalance,
  initiateWithdrawal,
  queryTransaction,
  isConfigured,
  generateSign,
};
