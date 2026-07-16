/**
 * logger.js — Colored terminal logging with timestamps and DB syncing
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
}

async function logToDB(level, message) {
  if (!supabase) return;
  try {
    await supabase.from('bot_logs').insert({ level, message });
  } catch {
    // Ignore to avoid crash loop
  }
}

const COLORS = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
  bgRed:   '\x1b[41m',
};

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function prefix(level, color, label) {
  return `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${color}[${label}]${COLORS.reset} ${COLORS.bold}`;
}

export const logger = {
  info: (msg, ...args) => {
    console.log(`${prefix('info', COLORS.cyan, 'INFO')}${msg}${COLORS.reset}`, ...args);
    logToDB('INFO', msg);
  },

  success: (msg, ...args) => {
    console.log(`${prefix('ok', COLORS.green, ' SUCCESS ')}${msg}${COLORS.reset}`, ...args);
    logToDB('SUCCESS', msg);
  },

  warn: (msg, ...args) => {
    console.warn(`${prefix('warn', COLORS.yellow, ' WARN ')}${msg}${COLORS.reset}`, ...args);
    logToDB('WARN', msg);
  },

  error: (msg, ...args) => {
    console.error(`${prefix('err', COLORS.red, ' ERROR ')}${msg}${COLORS.reset}`, ...args);
    logToDB('ERROR', msg);
  },

  alert: (msg, ...args) => {
    console.error(`\n${COLORS.bgRed}${COLORS.white}${COLORS.bold} ALERT: ${msg} ${COLORS.reset}\n`, ...args);
    logToDB('ALERT', msg);
  },

  receipt: (data) => {
    console.log(`\n${COLORS.magenta}${COLORS.bold}=================== NEW RECEIPT ===================${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}Amount:${COLORS.reset}           ${COLORS.bold}${data.amount} EGP${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}Recipient Name:${COLORS.reset}   ${data.recipientName || '—'}`);
    console.log(`  ${COLORS.cyan}Recipient Phone:${COLORS.reset}  ${data.recipientNumber || '—'}`);
    console.log(`  ${COLORS.cyan}Sender Wallet:${COLORS.reset}    ${COLORS.bold}${data.walletNumber || '—'}${COLORS.reset}`);
    console.log(`  ${COLORS.cyan}Reference ID:${COLORS.reset}     ${data.referenceId || '—'}`);
    console.log(`  ${COLORS.cyan}Date:${COLORS.reset}             ${data.date || '—'}`);
    console.log(`  ${COLORS.cyan}Provider:${COLORS.reset}         ${data.provider || '—'}`);
    console.log(`${COLORS.magenta}${COLORS.bold}===================================================${COLORS.reset}\n`);

    const msg = `New Receipt recorded: ${data.amount} EGP | Wallet: ${data.walletNumber} | Ref: ${data.referenceId}`;
    logToDB('RECEIPT', msg);
  },
};
