/**
 * supabaseService.js
 *
 * Handles all Supabase database operations for the WhatsApp bot.
 * Uses the SERVICE ROLE key to bypass Row-Level Security (RLS).
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logger } from './logger.js';

import fs from 'fs';
import path from 'path';

// Load environment variables for ESM execution order (.env.development if it exists, fallback to .env)
const devEnvPath = path.join(process.cwd(), '.env.development');
if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else {
  dotenv.config();
}

// ─── Client Init ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
  }
);

// ─── Duplicate Check ──────────────────────────────────────────
/**
 * Checks if a receipt was already processed (by referenceId).
 * Returns true if it's a duplicate.
 */
export async function isDuplicate(referenceId) {
  if (!referenceId) return false;

  const { data, error } = await supabase
    .from('whatsapp_transactions')
    .select('id')
    .eq('reference_id', referenceId)
    .maybeSingle();

  if (error) {
    logger.warn(`Duplicate check failed: ${error.message}`);
    return false;
  }

  return !!data;
}

// ─── Find Account by Wallet Number ───────────────────────────
/**
 * Finds an account in the database matching the wallet number (رقم المحفظة).
 * Returns the account object or null if not found.
 */
export async function findAccountByWalletNumber(walletNumber) {
  if (!walletNumber) return null;

  // Normalize: remove spaces, dashes
  const normalized = walletNumber.replace(/[\s\-]/g, '');

  const { data, error } = await supabase
    .from('accounts')
    .select('id, account_number, owner_name, current_balance')
    .eq('account_number', normalized)
    .maybeSingle();

  if (error) {
    logger.warn(`Account lookup failed: ${error.message}`);
    return null;
  }

  return data;
}

// ─── Record Transaction ───────────────────────────────────────
/**
 * Records a transaction (income or expense) and logs it in whatsapp_transactions.
 *
 * @param {Object} receiptData  - Extracted receipt fields
 * @param {string} accountId    - UUID of the matched account
 * @param {string} senderJid    - WhatsApp sender JID for traceability
 * @param {string} type         - 'income' | 'expense'
 * @returns {Object} result with transaction id
 */
export async function recordTransaction(receiptData, accountId, senderJid, type = 'expense') {
  const {
    amount,
    recipientName,
    recipientNumber,
    referenceId,
    date,
    walletNumber,
    provider,
    _model,
  } = receiptData;

  // Build description
  const descParts = [];
  if (provider && provider !== 'unknown') descParts.push(`[${provider.toUpperCase()}]`);
  if (type === 'income') descParts.push('(إيداع/استلام داخل)');
  if (recipientName) descParts.push(recipientName);
  if (recipientNumber) descParts.push(`(${recipientNumber})`);
  if (!descParts.length) descParts.push('تحويل أوتوماتيك من واتساب');
  const description = descParts.join(' ');

  // Transaction date: use extracted date or today
  const transactionDate = date || new Date().toISOString().substring(0, 10);

  // ── 1. Insert into transactions ──────────────────────────────
  const { data: txData, error: txError } = await supabase
    .from('transactions')
    .insert([{
      account_id:       accountId,
      type:             type === 'income' ? 'income' : 'expense',
      amount:           amount,
      description:      description,
      transaction_date: transactionDate,
    }])
    .select('id')
    .single();

  if (txError) {
    throw new Error(`Failed to insert transaction: ${txError.message}`);
  }

  logger.success(`Transaction recorded! ID: ${txData.id} | Type: ${type}`);

  // ── 2. Log in whatsapp_transactions ──────────────────────────
  const { error: logError } = await supabase
    .from('whatsapp_transactions')
    .insert([{
      transaction_id:      txData.id,
      reference_id:        referenceId || null,
      wallet_number:       walletNumber,
      recipient_number:    recipientNumber,
      recipient_name:      recipientName,
      provider:            provider,
      raw_extracted_data:  { ...receiptData, type },
      sender_jid:          senderJid,
      status:              'processed',
    }]);

  if (logError) {
    logger.warn(`WhatsApp log entry failed (non-fatal): ${logError.message}`);
  }

  return { transactionId: txData.id };
}

export async function recordExpenseTransaction(receiptData, accountId, senderJid) {
  return recordTransaction(receiptData, accountId, senderJid, 'expense');
}

// ─── Log Failed Attempt ───────────────────────────────────────
/**
 * Logs a failed receipt processing attempt to whatsapp_transactions.
 * Used for unmatched wallet numbers or OCR failures.
 *
 * @param {Object} receiptData   - Raw extracted data (may be partial)
 * @param {string} status        - 'no_account' | 'ocr_failed' | 'duplicate'
 * @param {string} senderJid     - WhatsApp sender JID
 * @param {string} errorMessage  - Human-readable error description
 */
export async function logFailedAttempt(receiptData, status, senderJid, errorMessage) {
  const { error } = await supabase
    .from('whatsapp_transactions')
    .insert([{
      transaction_id:      null,
      reference_id:        receiptData?.referenceId || null,
      wallet_number:       receiptData?.walletNumber || null,
      recipient_number:    receiptData?.recipientNumber || null,
      recipient_name:      receiptData?.recipientName || null,
      provider:            receiptData?.provider || null,
      raw_extracted_data:  receiptData || null,
      sender_jid:          senderJid,
      status:              status,
      error_message:       errorMessage,
    }]);

  if (error) {
    logger.warn(`Failed to log failed attempt: ${error.message}`);
  }
}

// ─── Check Duplicate Order ────────────────────────────────────
/**
 * Checks if an order with the same phone number and amount was created
 * in the last 24 hours.
 */
export async function checkDuplicateOrder(phoneNumber, amount) {
  if (!phoneNumber || !amount) return false;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('id')
    .eq('phone_number', phoneNumber)
    .eq('amount', amount)
    .gt('created_at', yesterday)
    .limit(1);

  if (error) {
    logger.warn(`Duplicate order check failed: ${error.message}`);
    return false;
  }

  return data && data.length > 0;
}

// ─── Insert Order ─────────────────────────────────────────────
/**
 * Inserts a new order into the database.
 */
export async function insertOrder(orderData, senderJid) {
  const { phoneNumber, amount, customerName, provider } = orderData;

  const { data, error } = await supabase
    .from('orders')
    .insert([{
      phone_number:  phoneNumber,
      amount:        amount,
      customer_name: customerName,
      provider:      provider,
      sender_jid:    senderJid,
    }])
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to insert order: ${error.message}`);
  }

  logger.success(`Order recorded successfully! ID: ${data.id}`);
  return data;
}

// ─── Bot Status & Commands Management ────────────────────────
/**
 * Updates the bot connection status and current QR code in the settings table.
 */
export async function updateBotStatus(status, qr = '') {
  try {
    await supabase
      .from('app_settings')
      .update({ value: status })
      .eq('key', 'bot_status');

    await supabase
      .from('app_settings')
      .update({ value: qr })
      .eq('key', 'bot_qr_code');
  } catch (err) {
    logger.warn(`Failed to update bot status in DB: ${err.message}`);
  }
}

/**
 * Clears the bot control command once executed.
 */
export async function clearBotCommand() {
  try {
    await supabase
      .from('app_settings')
      .update({ value: '' })
      .eq('key', 'bot_command');
  } catch (err) {
    logger.warn(`Failed to clear bot command in DB: ${err.message}`);
  }
}

/**
 * Upserts a discovered WhatsApp group into discovered_groups table.
 */
export async function upsertDiscoveredGroup(jid, name) {
  try {
    await supabase
      .from('discovered_groups')
      .upsert({
        jid,
        name,
        last_seen: new Date().toISOString()
      }, { onConflict: 'jid' });
  } catch (err) {
    // Ignore db write failures to prevent bot crashes
  }
}

// ─── USDT Transactions Helpers ────────────────────────────────

/**
 * Checks if a USDT transaction with reference_id exists already.
 */
export async function checkDuplicateUsdt(referenceId) {
  if (!referenceId) return false;

  const { data, error } = await supabase
    .from('usdt_transactions')
    .select('id')
    .eq('reference_id', referenceId)
    .maybeSingle();

  if (error) {
    logger.warn(`USDT duplicate check error: ${error.message}`);
    return false;
  }

  return !!data;
}

/**
 * Inserts a new USDT transaction record into usdt_transactions table.
 */
export async function insertUsdtTransaction(usdtData, senderJid) {
  const { amountUsdt, rateEgp, totalEgp, referenceId, recipientName, status, rawText } = usdtData;

  const { data, error } = await supabase
    .from('usdt_transactions')
    .insert([{
      amount_usdt:        amountUsdt,
      rate_egp:           rateEgp,
      total_egp:          totalEgp,
      reference_id:       referenceId || null,
      recipient_name:     recipientName || null,
      sender_jid:         senderJid || null,
      status:             status || 'processed',
      raw_extracted_data: { usdtData, rawText },
    }])
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to insert USDT transaction: ${error.message}`);
  }

  logger.success(`USDT Transaction recorded successfully! ID: ${data.id}`);
  return data;
}


