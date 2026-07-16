/**
 * orderExtractor.js
 *
 * Uses Google Gemini text generation API to extract mobile recharge/wallet orders
 * from Egyptian Arabic text messages in WhatsApp groups.
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
const ORDER_PROMPT = `You are analyzing a text message sent to an Egyptian WhatsApp group. Your job is to determine if this message represents a mobile recharge, wallet transfer, or cash-in order, and extract the structured details.

An order message typically contains:
1. An Egyptian phone number (e.g. 01061894082, or with country prefix like 00201282226924, +201229323503, 201229323503).
2. An amount (e.g. 650, 6,000, 1801, 1,230, etc.), which might be followed by "ج" or "جنيه" or "ج.م".
3. An optional customer name (e.g. "خالد", "محمدصفوة", "نهاد عبدالمجيد").
4. An optional provider/company name (e.g. "فودافون", "فودافون كاش", "اتصالات", "اورنج", "وي").

Analyze the message and extract:
- isOrder (boolean): Set to true ONLY if the message has a clear phone number and a valid, non-placeholder amount representing a transfer/recharge.
- phoneNumber (string): Clean the phone number. Remove spaces, dashes, colons, and any country prefix like "+20", "20", "002" or "2" at the start. It MUST be returned as a standard 11-digit local Egyptian number starting with "01" (e.g., "01061894082"). If no phone number is found, return null.
- amount (number): The amount as a plain number. Strip commas, spaces, currency symbols (e.g., convert "6,000" to 6000, and "1,230 ج.م" to 1230). If the amount is represented by a placeholder like "XXX" or is missing, return null.
- customerName (string or null): The customer's name if mentioned (e.g., "خالد", "محمدصفوة", "نهاد عبدالمجيد"). Do not include prefixes like "بإسم" or "اسم" or "بإسم:".
- provider (string or null): The mobile operator or wallet brand if mentioned (e.g., "فودافون", "فودافون كاش").

Respond with ONLY a valid JSON object:
{
  "isOrder": boolean,
  "phoneNumber": string_or_null,
  "amount": number_or_null,
  "customerName": string_or_null,
  "provider": string_or_null
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

// ─── Core: Call a single Gemini model ────────────────────────
async function callModel(modelName, text, apiKey) {
  const url = `${API_BASE}/${modelName}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [
        { text: ORDER_PROMPT },
        { text: `Text message to analyze:\n"""\n${text}\n"""` },
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
        isOrder:      !!parsed.isOrder,
        phoneNumber:  parsed.phoneNumber  ?? null,
        amount:       parsed.amount       ?? null,
        customerName: parsed.customerName ?? null,
        provider:     parsed.provider     ?? null,
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

// ─── Main Export ──────────────────────────────────────────────
export async function extractOrderData(text, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Read model chain from DB config (falls back to DEFAULT_MODEL_CHAIN)
  const modelChain = await config.getJson('gemini_model_chain', null, DEFAULT_MODEL_CHAIN);
  const errors = [];

  for (const modelName of modelChain) {
    try {
      return await callModel(modelName, text, apiKey);
    } catch (err) {
      logger.warn(`Gemini ❌ ${modelName}: ${err.message}`);
      errors.push({ model: modelName, error: err.message });
    }
  }

  // Fallback if all models fail
  throw new Error(`All Gemini models failed to parse text order: ${errors.map((e) => e.model).join(', ')}`);
}
