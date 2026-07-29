import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import dotenv from 'dotenv';
import { logger } from './lib/logger.js';
import { extractReceiptData } from './lib/receiptExtractor.js';
import { extractOrderData } from './lib/orderExtractor.js';
import { extractUsdtData, parseRateFromCaption } from './lib/usdtExtractor.js';
import { config } from './lib/configService.js';
import * as db from './lib/supabaseService.js';

import fs from 'fs';

// Load environment variables (.env.development if it exists, fallback to .env)
const devEnvPath = path.join(process.cwd(), '.env.development');
if (fs.existsSync(devEnvPath)) {
  dotenv.config({ path: devEnvPath });
} else {
  dotenv.config();
}

const AUTH_PATH = path.join(process.cwd(), 'auth_info');

// Helper to send WhatsApp text notification (alert)
async function sendAlert(sock, message, targetJid = null) {
  try {
    const alertNumber = await config.get('alert_phone_number', 'ALERT_PHONE_NUMBER', '');
    const alertPrefix = config.getSync('msg_alert_prefix', null, '🚨 *Hefny Accounting Alert:*');
    const recipient = targetJid || (alertNumber ? `${alertNumber}@s.whatsapp.net` : null);
    if (!recipient) {
      logger.warn('alert_phone_number is not configured (DB or .env)');
      return;
    }
    await sock.sendMessage(recipient, { text: `${alertPrefix} \n\n${message}` });
    logger.success(`Alert notification sent to: ${recipient}`);
  } catch (err) {
    logger.error('Failed to send alert notification:', err);
  }
}

const groupNameCache = new Map();

// Helper to fetch group name and cache it
async function getGroupName(sock, jid) {
  if (groupNameCache.has(jid)) {
    return groupNameCache.get(jid);
  }
  try {
    const metadata = await sock.groupMetadata(jid);
    if (metadata && metadata.subject) {
      groupNameCache.set(jid, metadata.subject);
      return metadata.subject;
    }
  } catch (err) {
    // Fail silently
  }
  return 'مجموعة غير معروفة';
}

// Helper to extract image message from message object
function getImageMessage(message) {
  if (!message) return null;
  const type = getContentType(message);
  if (type === 'imageMessage') {
    return message.imageMessage;
  }
  if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2') {
    const content = message[type]?.message;
    if (getContentType(content) === 'imageMessage') {
      return content.imageMessage;
    }
  }
  if (type === 'documentMessage') {
    const doc = message.documentMessage;
    if (doc.mimetype?.startsWith('image/')) {
      return doc;
    }
  }
  return null;
}

// Connection function
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  const waLogger = pino({ level: 'warn' });

  // Fetch the latest active WhatsApp Web protocol version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = (makeWASocket.default || makeWASocket)({
    version,
    auth: state,
    logger: waLogger,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 20_000,
    keepAliveIntervalMs: 30_000,
    defaultQueryTimeoutMs: undefined,
    retryRequestDelayMs: 250,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Scan the QR code below to connect WhatsApp:');
      qrcode.generate(qr, { small: true });
      await db.updateBotStatus('DISCONNECTED', qr);
    }

    if (connection === 'close') {
      if (sock.cmdInterval) clearInterval(sock.cmdInterval);

      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      logger.error(`Connection closed. Code: ${code ?? 'n/a'} — ${lastDisconnect?.error?.message || 'unknown'}`);
      
      if (lastDisconnect) {
        console.dir(lastDisconnect, { depth: null });
        if (lastDisconnect.error?.output) {
          logger.error(`Error Output: ${JSON.stringify(lastDisconnect.error.output, null, 2)}`);
        }
        if (lastDisconnect.error?.stack) {
          logger.error(`Error Stack: ${lastDisconnect.error.stack}`);
        }
      }

      if (shouldReconnect) {
        logger.info('Reconnecting in 3 seconds...');
        await db.updateBotStatus('CONNECTING');
        setTimeout(() => connectToWhatsApp(), 3000);
      } else {
        logger.alert('Logged out from WhatsApp. Please delete the auth_info directory and run again to scan a new QR code.');
        await db.updateBotStatus('DISCONNECTED');
      }
    } else if (connection === 'open') {
      logger.success('Successfully connected to WhatsApp!');
      await db.updateBotStatus('CONNECTED');

      const user = sock.user;
      logger.info(`Bot WhatsApp Number: ${user.id.split(':')[0]}`);

      // Periodically check for commands from dashboard
      const cmdInterval = setInterval(async () => {
        try {
          await config.refresh();
          const command = config.getSync('bot_command', null, '');
          if (command === 'LOGOUT') {
            logger.warn('Logout command received from Admin Panel. Logging out...');
            clearInterval(cmdInterval);
            await db.clearBotCommand();
            await db.updateBotStatus('DISCONNECTED');
            await sock.logout();
          }
        } catch (err) {
          logger.warn(`Failed to process bot commands: ${err.message}`);
        }
      }, 7000);

      sock.cmdInterval = cmdInterval;

      // Read target groups from DB (fresh on each connection)
      const targetGroups = await config.getList('target_group_ids', 'TARGET_GROUP_ID');
      if (targetGroups.length === 0) {
        logger.warn('target_group_ids is not configured (DB or .env).');
        logger.info('Please send a message to the target group and copy the Group ID logged in this console.');
      } else {
        logger.info(`Monitoring Groups: ${targetGroups.join(', ')}`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Monitor incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    logger.info(`[messages.upsert] Triggered with type: ${m.type}, messages count: ${m.messages.length}`);
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      try {
        // Read dynamic config on each message (served from cache)
        const apiKey   = await config.get('gemini_api_key', 'GEMINI_API_KEY', '');
        const targetGroups = await config.getList('target_group_ids', 'TARGET_GROUP_ID');
        const incomeGroups = await config.getList('income_group_ids', 'INCOME_GROUP_ID');

        const from       = msg.key.remoteJid;
        const isGroup    = from.endsWith('@g.us');
        const senderJid  = msg.key.participant || msg.key.remoteJid;
        const contentType = msg.message ? getContentType(msg.message) : 'no-message-content';

        logger.info(`[RECV] jid=${from} | isGroup=${isGroup} | sender=${senderJid.split('@')[0]} | type=${contentType || 'unknown'} | fromMe=${msg.key.fromMe}`);

        // Get group name and log it to terminal (so it goes to database bot_logs)
        if (isGroup) {
          const groupName = await getGroupName(sock, from);
          logger.info(`تلقيت رسالة في جروب "${groupName}" | معرف الجروب (Group ID) هو: ${from}`);
          await db.upsertDiscoveredGroup(from, groupName);
        }

        // Skip our own TEXT messages to avoid loops (bot auto-replies are always text).
        // Images with fromMe=true are the user's own uploads and must be processed.
        const isImageMessage = !!(msg.message?.imageMessage || msg.message?.ephemeralMessage?.message?.imageMessage || msg.message?.viewOnceMessage?.message?.imageMessage || msg.message?.viewOnceMessageV2?.message?.imageMessage);
        if (msg.key.fromMe && !isImageMessage) {
          continue;
        }

        // Discovery mode (no groups configured)
        if (isGroup && targetGroups.length === 0) {
          logger.info(`[DISCOVERY] Received group message in "${msg.pushName || 'Unknown'}" | Group JID ID: ${from}`);
          logger.info('Copy this ID to target_group_ids in the Admin Settings page.');
        }

        // Skip if not from target groups
        if (targetGroups.length > 0 && !targetGroups.includes(from)) {
          logger.info(`[SKIP] Message from other group (${from}), not in monitored groups. Ignoring.`);
          continue;
        }

        // Validate API key
        if (!apiKey) {
          logger.error('[SKIP] gemini_api_key is not configured in DB or .env. Cannot process messages.');
          continue;
        }

        // ── Image messages ───────────────────────────────────────
        const imageMsg = getImageMessage(msg.message);
        if (!imageMsg) {
          // Text message — check for order
          const text = msg.message?.conversation ||
                       msg.message?.extendedTextMessage?.text ||
                       '';

          const hasPhone = /(?:\+2|002|2)?01[0125]\d{8}/.test(text);

          if (hasPhone) {
            logger.info('Detected potential text order (contains phone number). Extracting details...');
            try {
              const orderData = await extractOrderData(text, apiKey);
              if (orderData.isOrder && orderData.phoneNumber && orderData.amount) {
                logger.info(`Extracted order: Phone=${orderData.phoneNumber} | Amount=${orderData.amount} | Name=${orderData.customerName || 'N/A'}`);

                const isDup = await db.checkDuplicateOrder(orderData.phoneNumber, orderData.amount);
                if (isDup) {
                  logger.warn(`Duplicate order rejected: Phone=${orderData.phoneNumber}, Amount=${orderData.amount}`);
                  const dupMsg = config.format(
                    config.getSync('msg_duplicate_order', null, '⚠️ *تنبيه:* الطلب الخاص بالرقم ({phone_number}) بمبلغ ({amount} ج.م) مسجل بالفعل خلال الـ 24 ساعة الماضية.'),
                    { phone_number: orderData.phoneNumber, amount: orderData.amount }
                  );
                  await sock.sendMessage(from, { text: dupMsg, quoted: msg });
                } else {
                  await db.insertOrder(orderData, senderJid);
                  logger.success(`Order saved silently to DB: Phone=${orderData.phoneNumber} | Amount=${orderData.amount}`);
                }
              } else {
                logger.info(`Text analyzed but not a valid order. Ignoring.`);
              }
            } catch (err) {
              logger.error('Error processing text order:', err);
            }
          } else {
            logger.info(`[SKIP] Not an image or order text (type=${contentType || 'none'}). Ignoring.`);
          }
          continue;
        }

        // ── Image processing ─────────────────────────────────────
        logger.info(`Received image in group from: ${msg.pushName || senderJid.split('@')[0]}`);

        try {
          logger.info('Downloading image...');
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: waLogger, reuploadRequest: sock.updateMediaMessage }
          );

          if (!buffer) {
            throw new Error('Image download failed - empty buffer');
          }

          const mimeType = imageMsg.mimetype || 'image/jpeg';
          const captionText = imageMsg.caption || '';
          logger.success(`Image downloaded successfully (${(buffer.length / 1024).toFixed(1)} KB) | Caption: "${captionText}"`);

          // ── 1. Check for USDT Receipt ──────────────────────────
          logger.info('Analyzing image with Gemini for USDT transaction & rate...');
          let usdtData = null;
          try {
            usdtData = await extractUsdtData(buffer, mimeType, captionText, apiKey);
          } catch (usdtErr) {
            logger.info(`USDT check skipped/failed: ${usdtErr.message}`);
          }

          if (usdtData && usdtData.isUsdtReceipt && usdtData.amountUsdt) {
            logger.info(`USDT Receipt detected! Amount: ${usdtData.amountUsdt} USDT | Rate: ${usdtData.rateEgp || 'N/A'} EGP`);

            if (!usdtData.rateEgp) {
              logger.warn('USDT detected but exchange rate (EGP/USDT) is missing from caption.');
              const noRateMsg = `⚠️ *تنبيه معاملة USDT:*\nتم استخراج المبلغ (${usdtData.amountUsdt} USDT)، ولكن لم يتبين سعر الصرف بالجنيه أسفل الصورة.\nيرجى كتابة السعر أسفل الصورة (مثال: 52 أو 52.5ج أو 52 جنيه).`;
              await sock.sendMessage(from, { text: noRateMsg, quoted: msg });
              continue;
            }

            // Duplicate check for USDT
            if (usdtData.referenceId) {
              const isDup = await db.checkDuplicateUsdt(usdtData.referenceId);
              if (isDup) {
                logger.warn(`Duplicate USDT transaction detected: ${usdtData.referenceId}`);
                const dupMsg = `⚠️ *تنبيه:* معاملة USDT ذات الرقم المرجعي (${usdtData.referenceId}) مسجلة مسبقاً في النظام.`;
                await sock.sendMessage(from, { text: dupMsg, quoted: msg });
                continue;
              }
            }

            // Save USDT transaction to DB
            await db.insertUsdtTransaction(usdtData, senderJid);

            // Send WhatsApp confirmation
            const usdtSuccessMsg = config.format(
              config.getSync('msg_usdt_success_template', null,
                '✅ *تم تسجيل معاملة USDT بنجاح!*\n━━━━━━━━━━━━━━━━━━\n💵 *المبلغ:* {amount_usdt} USDT\n💱 *سعر الصرف:* {rate_egp} ج.م / USDT\n💰 *الإجمالي بالمصري:* {total_egp} ج.م\n👤 *المستلم:* {recipient_name}\n🆔 *الرقم المرجعي:* {reference_id}\n━━━━━━━━━━━━━━━━━━\nتم تسجيل المعاملة وحساب إجمالي التحويل بنجاح.'
              ),
              {
                amount_usdt:    usdtData.amountUsdt,
                rate_egp:       usdtData.rateEgp,
                total_egp:      usdtData.totalEgp?.toLocaleString('ar-EG') || usdtData.totalEgp,
                recipient_name: usdtData.recipientName || 'غير متوفر',
                reference_id:   usdtData.referenceId   || 'غير متوفر',
              }
            );

            await sock.sendMessage(from, { text: usdtSuccessMsg, quoted: msg });
            logger.success('USDT Transaction recorded and reply sent.');
            continue;
          }

          // ── 2. Standard E-Wallet / Bank Receipt Processing ────
          logger.info('Sending image to Gemini for standard payment receipt analysis...');
          const receiptData = await extractReceiptData(buffer, mimeType, apiKey);

          // OCR failed
          if (!receiptData.amount || !receiptData.walletNumber) {
            logger.warn(`OCR incomplete — amount=${receiptData.amount} | wallet=${receiptData.walletNumber}`);
            await db.logFailedAttempt(receiptData, 'ocr_failed', senderJid, 'Failed to extract amount or wallet number from the receipt');
            await sendAlert(sock, `Failed to parse receipt from ${msg.pushName || senderJid.split('@')[0]} - could not extract amount or wallet number.`, from);
            continue;
          }

          logger.receipt(receiptData);

          // Duplicate check
          if (receiptData.referenceId) {
            const isDup = await db.isDuplicate(receiptData.referenceId);
            if (isDup) {
              logger.warn(`Duplicate receipt detected. Reference ID: ${receiptData.referenceId}`);
              await db.logFailedAttempt(receiptData, 'duplicate', senderJid, `Duplicate reference: ${receiptData.referenceId}`);
              const dupMsg = config.format(
                config.getSync('msg_duplicate_receipt', null, '⚠️ *تنبيه:* الإيصال ذو الرقم المرجعي ({reference_id}) مسجل مسبقاً في النظام. تم منع تكرار المعاملة.'),
                { reference_id: receiptData.referenceId }
              );
              await sock.sendMessage(from, { text: dupMsg, quoted: msg });
              continue;
            }
          }

          // Account lookup
          logger.info(`Searching database for account matching wallet number: ${receiptData.walletNumber}`);
          const account = await db.findAccountByWalletNumber(receiptData.walletNumber);

          if (!account) {
            logger.alert(`Wallet number ${receiptData.walletNumber} does not match any registered account!`);
            await db.logFailedAttempt(receiptData, 'no_account', senderJid, `Wallet number ${receiptData.walletNumber} not registered.`);

            const noAccMsg = config.format(
              config.getSync('msg_no_account', null, '❌ *خطأ في تسجيل المعاملة:*\nرقم المحفظة ({wallet_number}) غير مسجل في النظام البنكي.\nالمبلغ: {amount} ج.م\nالرجاء إضافة الحساب أولاً أو مراجعة الرقم.'),
              { wallet_number: receiptData.walletNumber, amount: receiptData.amount }
            );
            await sock.sendMessage(from, { text: noAccMsg, quoted: msg });
            await sendAlert(sock, `Wallet number (${receiptData.walletNumber}) unmatched! Amount: ${receiptData.amount} EGP`);
            continue;
          }

          logger.success(`Account matched: ${account.owner_name} (Balance: ${account.current_balance} EGP)`);

          // Determine transaction direction (income vs expense)
          const isIncomeGroup = incomeGroups.includes(from);
          const txType = isIncomeGroup ? 'income' : 'expense';

          logger.info(`Recording transaction direction as: ${txType} (isIncomeGroup: ${isIncomeGroup})`);

          // Record transaction
          await db.recordTransaction(receiptData, account.id, senderJid, txType);

          // Success reply
          const defaultTemplate = isIncomeGroup
            ? '✅ *تم تسجيل معاملة إيداع (داخل) بنجاح!*\n━━━━━━━━━━━━━━━━━━\n👤 *الحساب:* {account_name}\n💵 *المبلغ:* {amount} ج.م (إيداع/داخل)\n🏦 *المحفظة:* {wallet_number}\nℹ️ *المرسل:* {recipient_name}\n🆔 *الرقم المرجعي:* {reference_id}\n━━━━━━━━━━━━━━━━━━\n💰 تم زيادة رصيد الحساب تلقائياً.'
            : '✅ *تم تسجيل المعاملة تلقائياً بنجاح!*\n━━━━━━━━━━━━━━━━━━\n👤 *الحساب:* {account_name}\n💵 *المبلغ:* {amount} ج.م (صرف/خارج)\n🏦 *المحفظة:* {wallet_number}\nℹ️ *المرسل إليه:* {recipient_name}\n🆔 *الرقم المرجعي:* {reference_id}\n━━━━━━━━━━━━━━━━━━\n💰 تم تحديث الرصيد وحساب الحدود تلقائياً.';

          const templateKey = isIncomeGroup ? 'msg_income_success_template' : 'msg_success_template';

          const successMsg = config.format(
            config.getSync(templateKey, null, defaultTemplate),
            {
              account_name:   account.owner_name,
              amount:         receiptData.amount,
              wallet_number:  receiptData.walletNumber,
              recipient_name: receiptData.recipientName || 'غير متوفر',
              reference_id:   receiptData.referenceId  || 'غير متوفر',
            }
          );

          await sock.sendMessage(from, { text: successMsg, quoted: msg });
          logger.success(`Transaction (${txType}) recorded and reply sent.`);

        } catch (err) {
          logger.error('Error processing group message/image:', err);
          await sendAlert(sock, `Technical error processing receipt image: ${err.message}`);
        }
      } catch (outerErr) {
        logger.error('Unhandled error in message handler:', outerErr);
      }
    }
  });
}

// ─── Startup ─────────────────────────────────────────────────
logger.info('Starting Hefny WhatsApp Accounting Bot...');
logger.info('Loading configuration from Supabase DB (with .env fallback)...');

config.refresh().then(async () => {
  const apiKey = await config.get('gemini_api_key', 'GEMINI_API_KEY', '');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    logger.error('Please fill SUPABASE_URL and SUPABASE_SERVICE_KEY in .env file');
    process.exit(1);
  }

  if (!apiKey) {
    logger.warn('gemini_api_key not found in DB settings or .env. Please configure it via the Admin Settings page or .env file.');
  }

  connectToWhatsApp();
});
