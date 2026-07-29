/**
 * receiptExtractor.js
 *
 * Uses Google Gemini multimodal API to extract payment receipt data
 * from Egyptian e-wallet screenshots (Axis, Instapay, Vodafone Cash, etc.)
 * Returns structured JSON ready for Supabase insertion.
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
const RECEIPT_PROMPT = `You are analyzing an image from an Egyptian e-wallet, USSD confirmation screen, POS machine, or payment app (such as Axis, Instapay, Vodafone Cash, Orange Cash, Etisalat Cash, Fawry, USSD screens, etc.).

Extract the following fields from the image:

1. "المبلغ الكلي" or "المبلغ" (Total Amount) → amount (number, e.g. 40000 or 4000). Remove commas and "جنيه" or "ج.م".
2. "اسم المستقبل" (Recipient Name) → recipientName (string or null)
3. "رقم المرسل إليه" or "رقم الهاتف" (Recipient Phone Number) → recipientNumber (string or null)
4. "الرقم المرجعي" or "رقم العملية" (Reference/Transaction ID) → referenceId (string or null)
5. "التاريخ" (Date) → date in ISO format YYYY-MM-DD (string or null)
6. "رقم المحفظة" or "رقم الحساب" or "رقم الهاتف" (Wallet/Phone Number) → walletNumber (string or null)
7. Payment provider name (axis, instapay, vodafone_cash, orange_cash, etisalat_cash, fawry, other) → provider (string)

CRITICAL INSTRUCTIONS FOR PHONE NUMBERS & USSD SCREEN SHOTS:
- If the image contains a transfer message (e.g. "تم تحويل 40000 جنيه لرقم 01025024358" or "تم تحويل 4000 جنيه الي 01145368218"), extract the amount (40000 or 4000) and set the phone number as "walletNumber".
- ALWAYS extract any visible Egyptian phone number starting with 01 (e.g., 01025024358, 01145368218). If only one phone number is present in the image, set it as "walletNumber".
- Clean phone numbers: remove spaces, country prefixes (+20, 20, 002), dashes. Return standard 11-digit local Egyptian number (e.g. 01025024358).
- For amounts: return as a plain number (e.g., 40000 not "40,000 ج.م").

Respond with ONLY a valid JSON object:
{
  "amount": number_or_null,
  "recipientName": string_or_null,
  "recipientNumber": string_or_null,
  "referenceId": string_or_null,
  "date": "YYYY-MM-DD_or_null",
  "walletNumber": string_or_null,
  "provider": "axis|instapay|vodafone_cash|orange_cash|etisalat_cash|fawry|other|unknown"
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
async function callModel(modelName, imageBuffer, mimeType, apiKey) {
  const url = `${API_BASE}/${modelName}:generateContent?key=${apiKey}`;
  const base64Data = imageBuffer.toString('base64');

  const body = {
    contents: [{
      parts: [
        { text: RECEIPT_PROMPT },
        { inlineData: { mimeType, data: base64Data } },
      ],
    }],
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

      const cleanPhone = (num) => {
        if (!num) return null;
        const str = String(num).replace(/[\s\-\+\:]/g, '');
        const match = str.match(/(?:20|002)?(01[0125]\d{8})/);
        return match ? match[1] : str;
      };

      const rawWallet = cleanPhone(parsed.walletNumber);
      const rawRecipient = cleanPhone(parsed.recipientNumber);
      const finalWallet = rawWallet || rawRecipient || null;

      logger.success(`Gemini ✅ ${modelName}`);
      logger.info(`Extracted → amount=${parsed.amount} | wallet=${finalWallet} | provider=${parsed.provider}`);

      return {
        amount:          parsed.amount          ? parseFloat(parsed.amount) : null,
        recipientName:   parsed.recipientName   ?? null,
        recipientNumber: rawRecipient,
        referenceId:     parsed.referenceId     ?? null,
        date:            parsed.date            ?? null,
        walletNumber:    finalWallet,
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
 * Extracts payment receipt data from an image buffer using Gemini API.
 * @param {Buffer} imageBuffer  - Raw image bytes
 * @param {string} mimeType     - e.g. 'image/jpeg'
 * @param {string} apiKey       - Gemini API key
 * @returns {Promise<Object>}   - Structured receipt data
 */
export async function extractReceiptData(imageBuffer, mimeType, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Read model chain from DB config (falls back to DEFAULT_MODEL_CHAIN)
  const modelChain = await config.getJson('gemini_model_chain', null, DEFAULT_MODEL_CHAIN);
  const errors = [];

  for (const modelName of modelChain) {
    try {
      logger.info(`🧠 Trying Gemini model: ${modelName}`);
      return await callModel(modelName, imageBuffer, mimeType, apiKey);
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
