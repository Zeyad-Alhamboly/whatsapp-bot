/**
 * receiptExtractor.js
 *
 * Uses Google Gemini multimodal API to extract payment receipt data
 * from Egyptian e-wallet screenshots (Axis, Instapay, Vodafone Cash, etc.)
 * AND cryptocurrency transfers (USDT / Binance Pay) in a SINGLE unified call.
 * Returns structured JSON ready for Supabase insertion.
 */

import { logger } from './logger.js';
import { config } from './configService.js';
import { parseRateFromCaption } from './usdtExtractor.js';

const DEFAULT_MODEL_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
];

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2000;

// ─── Unified Extraction Prompt ────────────────────────────────
const RECEIPT_PROMPT = `You are an expert financial receipt analyzer for Egyptian payment systems and cryptocurrency transfers.
Analyze the provided screenshot or receipt image.

CRITICAL CLASSIFICATION INSTRUCTIONS:
1. USDT / CRYPTO RECEIPT:
   - Set "isUsdtReceipt": true ONLY if the image is explicitly a USDT, Tether, Binance Pay, OKX, Bybit, KuCoin, or Crypto transfer receipt.
   - Extract "amountUsdt" as a plain number (e.g. 50 or 52.5). Strip "USDT" or "$".
   - Extract "referenceId" (Order ID or Transaction ID), "recipientName" (recipient name or nickname, e.g. Hefny7x), and "date" (YYYY-MM-DD).
   - Set "amount": null, "walletNumber": null, "provider": "binance_pay" | "okx" | "bybit" | "crypto" | "usdt".

2. EGYPTIAN E-WALLET / BANK / USSD RECEIPT:
   - If the image is an Egyptian E-Wallet or bank receipt (such as Axis, Instapay, Vodafone Cash, Orange Cash, Etisalat Cash, Fawry, USSD confirmation screens, Bank الأهلي/مصر) or if the currency is EGP / ج.م / جنيه:
     - Set "isUsdtReceipt": false and "amountUsdt": null.
     - Extract "amount": total amount as plain number (e.g. 2030 or 540). Remove commas and "جنيه" or "ج.م".
     - SENDER WALLET NUMBER vs RECIPIENT NUMBER (CRITICAL — DO NOT CONFUSE THEM):
       * "walletNumber": The SENDER's own wallet or account number (المحفظة المحول منها أو المسجل عليها المعاملة).
         - In Axis, Instapay, or bank apps: Look for the field explicitly labeled "رقم المحفظة" or "رقم المحفظه" or "من محفظة" or "حساب المحفظة" (typically at the bottom of the receipt).
         - Overlays / Stickers / Added Labels: If there is an overlaid text box, white sticker, or added text on the screenshot saying e.g. "رقم المحفظه: 01067542357" or "رقم المحفظة: 01...", ALWAYS extract that number as "walletNumber".
         - Caption: If a user caption accompanies the image specifying a wallet number, extract it as "walletNumber".
         - NEVER put the recipient's phone number into "walletNumber"!
       * "recipientNumber": The RECIPIENT's phone number (رقم الشخص أو الجهة المحول إليها).
         - In Axis: Look for the field labeled "رقم المرسل إليه".
         - In USSD / SMS / Vodafone Cash / Orange / Etisalat: Look for the number after "لرقم" or "إلى رقم" or "الي" or "المحول إليه" (e.g. in "تم تحويل 2030 جنيه لرقم 01010163522", "01010163522" is "recipientNumber", NEVER "walletNumber").
         - If the screenshot ONLY contains a transfer message like "تم تحويل 2030 جنيه لرقم 01010163522" with NO "رقم المحفظة" label/overlay/caption, set "recipientNumber" to "01010163522" and set "walletNumber" to null.
     - Extract "recipientName": Recipient Name or null.
     - Extract "referenceId": Reference / Transaction ID or null.
     - Extract "date": Date in ISO format YYYY-MM-DD or null.
     - Extract "provider": "axis" | "instapay" | "vodafone_cash" | "orange_cash" | "etisalat_cash" | "fawry" | "other" | "unknown".

Clean Egyptian phone numbers: remove spaces, country prefixes (+20, 20, 002), dashes. Return standard 11-digit local Egyptian number (e.g. 01067542357).

Respond with ONLY a valid JSON object:
{
  "isUsdtReceipt": boolean,
  "amountUsdt": number_or_null,
  "amount": number_or_null,
  "walletNumber": string_or_null,
  "recipientName": string_or_null,
  "recipientNumber": string_or_null,
  "referenceId": string_or_null,
  "date": "YYYY-MM-DD_or_null",
  "provider": string
}`;

// ─── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractTextFromResponse(result) {
  const parts = result.candidates?.[0]?.content?.parts;
  if (!parts?.length) {
    const finishReason = result.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') throw new Error('SAFETY_BLOCKED');
    throw new Error('EMPTY_RESPONSE');
  }

  // Handle "thinking" models (return last non-thought part)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].thought && parts[i].text) return parts[i].text;
  }

  const last = parts[parts.length - 1]?.text;
  if (last) return last;
  throw new Error('EMPTY_RESPONSE');
}

function extractJson(str) {
  if (!str) throw new Error('Empty response');

  const cleaned = str.trim();

  // 1. Direct parse
  try { return JSON.parse(cleaned); } catch (_) { /* continue */ }

  // 2. Strip markdown fences
  const fenceStripped = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try { return JSON.parse(fenceStripped); } catch (_) { /* continue */ }

  // 3. Extract between first { and last }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(cleaned.substring(first, last + 1)); } catch (_) { /* continue */ }
  }

  throw new Error(`Cannot parse JSON: ${cleaned.substring(0, 200)}`);
}

// ─── Core: Call a single Gemini model ────────────────────────
async function callModel(modelName, imageBuffer, mimeType, apiKey, captionText = '') {
  const url = `${API_BASE}/${modelName}:generateContent?key=${apiKey}`;
  const base64Data = imageBuffer.toString('base64');

  const parts = [{ text: RECEIPT_PROMPT }];
  if (captionText && captionText.trim()) {
    parts.push({ text: `User caption sent with this image: "${captionText.trim()}"` });
  }
  parts.push({ inlineData: { mimeType, data: base64Data } });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.status === 429 || response.status === 503) {
        logger.warn(`Gemini ${modelName} → ${response.status} (attempt ${attempt + 1})`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw new Error(`MODEL_UNAVAILABLE:${response.status}`);
      }

      if (response.status === 404) throw new Error(`MODEL_NOT_FOUND:${modelName}`);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`API_ERROR:${response.status} — ${errBody.substring(0, 100)}`);
      }

      const result = await response.json();
      const text = extractTextFromResponse(result);
      const parsed = extractJson(text);

      logger.success(`Gemini ✅ ${modelName}`);

      if (parsed.isUsdtReceipt) {
        const amountUsdt = parsed.amountUsdt ? parseFloat(parsed.amountUsdt) : null;
        logger.info(`Extracted USDT → amount=${amountUsdt} | ref=${parsed.referenceId} | recipient=${parsed.recipientName}`);
        return {
          isUsdtReceipt:   true,
          amountUsdt:      amountUsdt,
          amount:          null,
          walletNumber:    null,
          recipientNumber: null,
          recipientName:   parsed.recipientName   ?? null,
          referenceId:     parsed.referenceId     ?? null,
          date:            parsed.date            ?? null,
          provider:        parsed.provider        ?? 'binance_pay',
          _model:          modelName,
        };
      }

      const cleanPhone = (num) => {
        if (!num) return null;
        const str = String(num)
          .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
          .replace(/[\s\-\+\:]/g, '');
        const match = str.match(/(?:20|002)?(01[0125]\d{8})/);
        return match ? match[1] : (str || null);
      };

      const rawWallet = cleanPhone(parsed.walletNumber);
      const rawRecipient = cleanPhone(parsed.recipientNumber);

      logger.info(`Extracted Receipt → amount=${parsed.amount} | wallet=${rawWallet} | recipient=${rawRecipient} | provider=${parsed.provider}`);

      return {
        isUsdtReceipt:   false,
        amountUsdt:      null,
        amount:          parsed.amount          ? parseFloat(parsed.amount) : null,
        recipientName:   parsed.recipientName   ?? null,
        recipientNumber: rawRecipient,
        referenceId:     parsed.referenceId     ?? null,
        date:            parsed.date            ?? null,
        walletNumber:    rawWallet,
        provider:        parsed.provider        ?? 'unknown',
        _model:          modelName,
      };

    } catch (err) {
      if (
        err.message.startsWith('MODEL_NOT_FOUND') ||
        err.message.startsWith('MODEL_UNAVAILABLE') ||
        err.message === 'SAFETY_BLOCKED'
      ) {
        throw err; // propagate to try next model
      }

      if (attempt < MAX_RETRIES) {
        logger.warn(`Gemini ${modelName} attempt ${attempt + 1} failed: ${err.message}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}

// ─── Main Export ──────────────────────────────────────────────
/**
 * Extracts payment receipt data (standard Egyptian e-wallets OR USDT)
 * from an image buffer using a single unified Gemini API call.
 *
 * @param {Buffer} imageBuffer  - Raw image bytes
 * @param {string} mimeType     - e.g. 'image/jpeg'
 * @param {string} apiKey       - Gemini API key
 * @param {string} captionText  - Optional caption text sent with the image
 * @returns {Promise<Object>}   - Structured receipt or USDT data
 */
export async function extractReceiptData(imageBuffer, mimeType, apiKey, captionText = '') {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Read model chain from DB config (falls back to DEFAULT_MODEL_CHAIN)
  const modelChain = await config.getJson('gemini_model_chain', null, DEFAULT_MODEL_CHAIN);
  const errors = [];

  for (const modelName of modelChain) {
    try {
      logger.info(`🧠 Trying Gemini model: ${modelName}`);
      const result = await callModel(modelName, imageBuffer, mimeType, apiKey, captionText);

      // If it's a USDT receipt, calculate rate and total from caption
      if (result.isUsdtReceipt && result.amountUsdt) {
        const rateEgp = parseRateFromCaption(captionText);
        const totalEgp = (result.amountUsdt && rateEgp) ? Number((result.amountUsdt * rateEgp).toFixed(2)) : null;
        return {
          ...result,
          rateEgp,
          totalEgp,
          rawText: captionText || '',
        };
      }

      return {
        ...result,
        rateEgp: null,
        totalEgp: null,
        rawText: captionText || '',
      };
    } catch (err) {
      logger.warn(`Gemini ❌ ${modelName}: ${err.message}`);
      errors.push({ model: modelName, error: err.message });
    }
  }

  // All models failed
  const hasOverload = errors.some((e) => e.error.includes('UNAVAILABLE') || e.error.includes('503'));
  if (hasOverload) {
    throw new Error('Gemini overloaded — all models busy. Retry in a minute.');
  }

  throw new Error(`All Gemini models failed: ${errors.map((e) => e.model).join(', ')}`);
}
