/**
 * usdtExtractor.js
 *
 * Extracts USDT payment/transfer details from screenshots (Binance Pay, OKX, Bybit, KuCoin, Crypto Wallets)
 * and parses exchange rate (EGP/USDT) from text captions (e.g., "52", "52.5ج", "52 جنيه", "52.5 EGP").
 */

import { logger } from './logger.js';
import { config } from './configService.js';

const DEFAULT_MODEL_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-lite-latest',
];

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2000;

// ─── Extraction Prompt ────────────────────────────────────────
const USDT_PROMPT = `You are analyzing an image to determine if it is a USDT / Binance Pay / Crypto transfer receipt.

CRITICAL INSTRUCTIONS:
1. Check if the image is explicitly a USDT / Crypto transfer or Binance Pay receipt (e.g., showing USDT, Tether, Binance, OKX, Bybit, KuCoin, Crypto, etc.).
2. If the image is an Egyptian E-Wallet or bank receipt (such as Axis, Instapay, Vodafone Cash, Orange Cash, Etisalat Cash, Fawry, Bank الأهلي/مصر) or if the currency is EGP / ج.م / جنيه, IT IS NOT A USDT RECEIPT. Set "isUsdtReceipt": false and "amountUsdt": null.
3. Set "isUsdtReceipt": true ONLY if it is explicitly a USDT / Crypto / Binance Pay transaction.

Fields to extract:
- isUsdtReceipt (boolean): true ONLY if explicitly USDT / Binance Pay / Crypto receipt.
- amountUsdt (number or null): USDT amount (e.g., 50 or 52.5). Strip "USDT" or "$", return as plain number. Return null if not a USDT receipt.
- referenceId (string or null): Order ID or Transaction ID.
- recipientName (string or null): Recipient name or nickname (e.g. Hefny7x).
- date (string or null): YYYY-MM-DD.

Respond with ONLY a valid JSON object:
{
  "isUsdtReceipt": boolean,
  "amountUsdt": number_or_null,
  "referenceId": string_or_null,
  "recipientName": string_or_null,
  "date": "YYYY-MM-DD_or_null"
}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractTextFromResponse(result) {
  const parts = result.candidates?.[0]?.content?.parts;
  if (!parts?.length) {
    const finishReason = result.candidates?.[0]?.finishReason;
    if (finishReason === 'SAFETY') throw new Error('SAFETY_BLOCKED');
    throw new Error('EMPTY_RESPONSE');
  }

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

  try { return JSON.parse(cleaned); } catch (_) {}

  const fenceStripped = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try { return JSON.parse(fenceStripped); } catch (_) {}

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(cleaned.substring(first, last + 1)); } catch (_) {}
  }

  throw new Error(`Cannot parse JSON: ${cleaned.substring(0, 200)}`);
}

/**
 * Extracts numeric exchange rate (EGP/USDT) from text caption.
 * Handles formats like:
 * - "52"
 * - "52.5ج"
 * - "52.5 ج"
 * - "52 جنيه"
 * - "52.5 EGP"
 * - "سعر 52.5"
 */
export function parseRateFromCaption(caption) {
  if (!caption || typeof caption !== 'string') return null;

  // Clean caption text
  const text = caption.trim();

  // Regex to extract numbers (including floating point) preceded or followed by EGP words/chars or standalone
  // Matches expressions like "52.5", "52.5ج", "52 جنيه", "52.5egp", "سعر 52.5"
  const match = text.match(/(?:سعر\s*)?(\d+(?:\.\d+)?)\s*(?:ج\.م|جنيه|ج|egp|le)?/i);

  if (match && match[1]) {
    const rate = parseFloat(match[1]);
    if (!isNaN(rate) && rate > 0 && rate < 1000) {
      return rate;
    }
  }

  return null;
}

// ─── Call Gemini ──────────────────────────────────────────────
async function callModel(modelName, imageBuffer, mimeType, apiKey) {
  const url = `${API_BASE}/${modelName}:generateContent?key=${apiKey}`;
  const base64Data = imageBuffer.toString('base64');

  const body = {
    contents: [{
      parts: [
        { text: USDT_PROMPT },
        { inlineData: { mimeType, data: base64Data } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
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
      const extractedText = extractTextFromResponse(result);
      const parsed = extractJson(extractedText);

      return {
        isUsdtReceipt: !!parsed.isUsdtReceipt,
        amountUsdt:    parsed.isUsdtReceipt && parsed.amountUsdt ? parseFloat(parsed.amountUsdt) : null,
        referenceId:   parsed.referenceId   ?? null,
        recipientName: parsed.recipientName ?? null,
        date:          parsed.date          ?? null,
        _model:        modelName,
      };

    } catch (err) {
      if (
        err.message.startsWith('MODEL_NOT_FOUND') ||
        err.message.startsWith('MODEL_UNAVAILABLE') ||
        err.message === 'SAFETY_BLOCKED'
      ) {
        throw err;
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

/**
 * Main function to extract USDT receipt details and combine with caption rate.
 * @param {Buffer} imageBuffer - Raw image buffer
 * @param {string} mimeType - Image mime type
 * @param {string} captionText - Text caption sent with the image
 * @param {string} apiKey - Gemini API Key
 */
export async function extractUsdtData(imageBuffer, mimeType, captionText, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const modelChain = await config.getJson('gemini_model_chain', null, DEFAULT_MODEL_CHAIN);
  const errors = [];
  let imageResult = null;

  for (const modelName of modelChain) {
    try {
      logger.info(`🧠 Trying Gemini model for USDT extraction: ${modelName}`);
      imageResult = await callModel(modelName, imageBuffer, mimeType, apiKey);
      break;
    } catch (err) {
      logger.warn(`Gemini ❌ ${modelName}: ${err.message}`);
      errors.push({ model: modelName, error: err.message });
    }
  }

  if (!imageResult) {
    throw new Error(`All Gemini models failed for USDT receipt: ${errors.map(e => e.model).join(', ')}`);
  }

  // If not explicitly a USDT receipt, return isUsdtReceipt = false
  if (!imageResult.isUsdtReceipt || !imageResult.amountUsdt) {
    return {
      isUsdtReceipt: false,
      amountUsdt: null,
      rateEgp: null,
      totalEgp: null,
      referenceId: null,
      recipientName: null,
      date: null,
    };
  }

  // Parse exchange rate from caption
  const rateEgp = parseRateFromCaption(captionText);

  // Compute total EGP if both amount and rate are valid
  const amountUsdt = imageResult.amountUsdt;
  const totalEgp = (amountUsdt && rateEgp) ? Number((amountUsdt * rateEgp).toFixed(2)) : null;

  return {
    isUsdtReceipt: true,
    amountUsdt,
    rateEgp,
    totalEgp,
    referenceId: imageResult.referenceId,
    recipientName: imageResult.recipientName,
    date: imageResult.date,
    rawText: captionText || '',
    _model: imageResult._model,
  };
}
