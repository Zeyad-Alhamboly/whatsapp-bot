/**
 * incomeExtractor.js
 *
 * Extracts income / deposit transaction details from text messages in WhatsApp income groups.
 * Supports the following templates:
 *
 * Template 1:
 *   [Name] (optional)
 *   [Phone Number]
 *   [Amount]
 *
 * Template 2:
 *   [Phone Number]
 *   [Amount]
 */

import { logger } from './logger.js';

// Convert Arabic digits ٠-٩ to English 0-9
export function convertArabicDigits(str) {
  if (!str) return '';
  return str.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

// Clean phone number to standard 11-digit Egyptian local format (01xxxxxxxxx)
export function normalizeEgyptianPhone(phoneStr) {
  if (!phoneStr) return null;
  let cleaned = convertArabicDigits(phoneStr).replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+20')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('0020')) {
    cleaned = '0' + cleaned.slice(4);
  } else if (cleaned.startsWith('20') && cleaned.length === 12) {
    cleaned = '0' + cleaned.slice(2);
  }

  if (/^01[0125]\d{8}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

/**
 * Extracts income text data from raw message text.
 *
 * @param {string} rawText
 * @returns {{ isIncome: boolean, phoneNumber: string|null, amount: number|null, customerName: string|null }}
 */
export function extractIncomeTextData(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { isIncome: false, phoneNumber: null, amount: null, customerName: null };
  }

  const text = convertArabicDigits(rawText);

  // Split into non-empty lines, excluding divider lines (e.g. ========== or ----)
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^[=\-*#_]{3,}$/.test(line));

  let phoneNumber = null;
  let amount = null;
  let customerName = null;

  let phoneLineIndex = -1;
  let amountLineIndex = -1;

  const phoneRegex = /(?:\+20|0020|20)?(01[0125]\d{8})/;

  // 1. Find phone number line
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(phoneRegex);
    if (match) {
      const normalized = normalizeEgyptianPhone(match[0]);
      if (normalized) {
        phoneNumber = normalized;
        phoneLineIndex = i;
        break;
      }
    }
  }

  // 2. Find amount line
  for (let i = 0; i < lines.length; i++) {
    if (i === phoneLineIndex) continue;

    const line = lines[i];
    // Strip common currency keywords and commas
    const cleanedLine = line
      .replace(/,/g, '')
      .replace(/(?:ج\.م|ج|جنيه|مصري|EGP|egp)/gi, '')
      .trim();

    // Match numeric line (integer or decimal)
    if (/^\d+(?:\.\d+)?$/.test(cleanedLine)) {
      const num = parseFloat(cleanedLine);
      if (num > 0 && num.toString() !== phoneNumber) {
        amount = num;
        amountLineIndex = i;
        break;
      }
    }
  }

  // Fallback: If amount line wasn't found separately, search across the full text
  if (!amount) {
    const amountMatches = text.matchAll(/(?:\b|ج\.م|ج|جنيه|\s)(\d[\d,.]*)\s*(?:ج|ج\.م|جنيه)?/gi);
    for (const match of amountMatches) {
      const cleanVal = match[1].replace(/,/g, '');
      const num = parseFloat(cleanVal);
      if (!isNaN(num) && num > 0 && cleanVal !== phoneNumber && cleanVal.length < 10) {
        amount = num;
        break;
      }
    }
  }

  // 3. Find customer name line (any remaining line that is not phone or amount)
  for (let i = 0; i < lines.length; i++) {
    if (i !== phoneLineIndex && i !== amountLineIndex) {
      const candidate = lines[i].trim();
      // Remove common prefix labels if user added them
      const cleanCandidate = candidate.replace(/^(?:الاسم|اسم العميل|اسم|عميل):?\s*/i, '').trim();
      if (cleanCandidate && !/^\d+(?:\.\d+)?$/.test(cleanCandidate) && !phoneRegex.test(cleanCandidate)) {
        customerName = cleanCandidate;
        break;
      }
    }
  }

  const isIncome = !!(phoneNumber && amount);

  return {
    isIncome,
    phoneNumber,
    amount,
    customerName,
  };
}
