// ═══════════════════════════════════════════════════════════════════════════
// LICENSE SERVER — index.js
// Telegram Bot + REST API for Chrome Extension License System
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const mongoose   = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const PORT   = process.env.PORT || 3000;
const ADMIN  = String(process.env.ADMIN_TELEGRAM_ID);

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── MongoDB Schema ────────────────────────────────────────────────────────
const licenseSchema = new mongoose.Schema({
  key:        { type: String, unique: true, required: true },
  duration:   { type: Number, required: true },   // in minutes
  durationLabel: { type: String },                // "30 minutes", "1 day", etc.
  createdAt:  { type: Date, default: Date.now },
  activatedAt:{ type: Date, default: null },
  expiresAt:  { type: Date, default: null },
  status:     { type: String, enum: ['unused','active','expired','revoked'], default: 'unused' },
  usedBy:     { type: String, default: null },    // optional identifier
});

const License = mongoose.model('License', licenseSchema);

// ── Telegram Bot ──────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

function isAdmin(chatId) {
  return String(chatId) === ADMIN;
}

function parseDuration(input) {
  // Accepts: 30m, 30min, 30minutes, 1h, 1hr, 1d, 1day, 7days
  const s = input.trim().toLowerCase();
  const match = s.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?)$/);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2][0];
  if (unit === 'm') return { minutes: num, label: `${num} minute${num !== 1 ? 's' : ''}` };
  if (unit === 'h') return { minutes: num * 60, label: `${num} hour${num !== 1 ? 's' : ''}` };
  if (unit === 'd') return { minutes: num * 1440, label: `${num} day${num !== 1 ? 's' : ''}` };
  return null;
}

function formatTimeLeft(expiresAt) {
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'Expired';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function licenseStatusEmoji(status) {
  return { unused: '🟡', active: '🟢', expired: '🔴', revoked: '⛔' }[status] || '❓';
}

// ── Bot Commands ──────────────────────────────────────────────────────────

// /start or /help
bot.onText(/^\/(start|help)$/, (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  bot.sendMessage(msg.chat.id,
`🔑 *License Key Manager*

*Generate Keys:*
/getToken 30m — 30 minutes
/getToken 1h — 1 hour  
/getToken 1d — 1 day
/getToken 7d — 7 days

*Manage Keys:*
/list — All keys with status
/listActive — Active keys only
/listUnused — Unused keys only
/check <key> — Check key status
/revoke <key> — Revoke a key

*Durations:* m/min=minutes, h/hr=hours, d/day=days`,
    { parse_mode: 'Markdown' }
  );
});

// /getToken <duration>
bot.onText(/^\/getToken\s+(.+)$/i, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const parsed = parseDuration(match[1]);
  if (!parsed) {
    return bot.sendMessage(msg.chat.id,
      '❌ Invalid duration.\n\nExamples: `30m`, `1h`, `1d`, `7d`',
      { parse_mode: 'Markdown' }
    );
  }

  const key = 'LIC-' + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 20);
  const license = new License({
    key,
    duration: parsed.minutes,
    durationLabel: parsed.label,
    status: 'unused',
  });

  await license.save();

  bot.sendMessage(msg.chat.id,
`✅ *License Key Generated*

\`${key}\`

⏱ Duration: *${parsed.label}*
📅 Created: ${new Date().toLocaleString()}
🟡 Status: Unused (activates on first use)

_Share this key with the user. It will start counting down when first entered in the extension._`,
    { parse_mode: 'Markdown' }
  );
});

// /list — all keys
bot.onText(/^\/list$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const licenses = await License.find().sort({ createdAt: -1 }).limit(30);
  if (!licenses.length) return bot.sendMessage(msg.chat.id, '📭 No keys found.');

  let text = `📋 *All License Keys* (last 30)\n\n`;
  for (const lic of licenses) {
    const emoji = licenseStatusEmoji(lic.status);
    const timeLeft = lic.status === 'active' ? ` | ⏳ ${formatTimeLeft(lic.expiresAt)} left` : '';
    text += `${emoji} \`${lic.key}\`\n`;
    text += `   ${lic.durationLabel} | ${lic.status.toUpperCase()}${timeLeft}\n\n`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /listActive
bot.onText(/^\/listActive$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  // Auto-expire first
  await License.updateMany(
    { status: 'active', expiresAt: { $lt: new Date() } },
    { $set: { status: 'expired' } }
  );

  const licenses = await License.find({ status: 'active' }).sort({ expiresAt: 1 });
  if (!licenses.length) return bot.sendMessage(msg.chat.id, '📭 No active keys.');

  let text = `🟢 *Active Keys* (${licenses.length})\n\n`;
  for (const lic of licenses) {
    text += `\`${lic.key}\`\n`;
    text += `   ⏳ ${formatTimeLeft(lic.expiresAt)} remaining\n`;
    text += `   Expires: ${new Date(lic.expiresAt).toLocaleString()}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /listUnused
bot.onText(/^\/listUnused$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const licenses = await License.find({ status: 'unused' }).sort({ createdAt: -1 });
  if (!licenses.length) return bot.sendMessage(msg.chat.id, '📭 No unused keys.');

  let text = `🟡 *Unused Keys* (${licenses.length})\n\n`;
  for (const lic of licenses) {
    text += `\`${lic.key}\`\n`;
    text += `   Duration: ${lic.durationLabel}\n`;
    text += `   Created: ${new Date(lic.createdAt).toLocaleString()}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /check <key>
bot.onText(/^\/check\s+(.+)$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const key = match[1].trim().toUpperCase();
  const lic = await License.findOne({ key });

  if (!lic) return bot.sendMessage(msg.chat.id, `❌ Key not found: \`${key}\``, { parse_mode: 'Markdown' });

  // Auto-expire check
  if (lic.status === 'active' && lic.expiresAt < new Date()) {
    lic.status = 'expired';
    await lic.save();
  }

  const emoji = licenseStatusEmoji(lic.status);
  let text = `${emoji} *Key Status*\n\n\`${lic.key}\`\n\n`;
  text += `📌 Status: *${lic.status.toUpperCase()}*\n`;
  text += `⏱ Duration: ${lic.durationLabel}\n`;
  text += `📅 Created: ${new Date(lic.createdAt).toLocaleString()}\n`;

  if (lic.activatedAt) {
    text += `🚀 Activated: ${new Date(lic.activatedAt).toLocaleString()}\n`;
  }
  if (lic.expiresAt) {
    text += `📆 Expires: ${new Date(lic.expiresAt).toLocaleString()}\n`;
  }
  if (lic.status === 'active') {
    text += `⏳ Time Left: *${formatTimeLeft(lic.expiresAt)}*\n`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /revoke <key>
bot.onText(/^\/revoke\s+(.+)$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const key = match[1].trim().toUpperCase();
  const lic = await License.findOneAndUpdate(
    { key },
    { $set: { status: 'revoked' } },
    { new: true }
  );

  if (!lic) return bot.sendMessage(msg.chat.id, `❌ Key not found: \`${key}\``, { parse_mode: 'Markdown' });

  bot.sendMessage(msg.chat.id,
    `⛔ *Key Revoked*\n\n\`${key}\`\n\nThis key will no longer work in the extension.`,
    { parse_mode: 'Markdown' }
  );
});

// ── REST API ──────────────────────────────────────────────────────────────

// POST /api/validate — Called by extension to validate/activate key
app.post('/api/validate', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ valid: false, reason: 'No key provided' });

  const lic = await License.findOne({ key: key.toUpperCase().trim() });
  if (!lic) return res.json({ valid: false, reason: 'invalid' });

  if (lic.status === 'revoked') return res.json({ valid: false, reason: 'revoked' });
  if (lic.status === 'expired') return res.json({ valid: false, reason: 'expired' });

  // First use — activate the key
  if (lic.status === 'unused') {
    lic.activatedAt = new Date();
    lic.expiresAt   = new Date(Date.now() + lic.duration * 60 * 1000);
    lic.status      = 'active';
    await lic.save();
  }

  // Already active — check if expired now
  if (lic.status === 'active' && lic.expiresAt < new Date()) {
    lic.status = 'expired';
    await lic.save();
    return res.json({ valid: false, reason: 'expired' });
  }

  const msLeft = new Date(lic.expiresAt) - Date.now();

  return res.json({
    valid:    true,
    key:      lic.key,
    status:   lic.status,
    expiresAt: lic.expiresAt,
    msLeft,
    durationLabel: lic.durationLabel,
  });
});

// POST /api/status — Extension polls this periodically
app.post('/api/status', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ valid: false, reason: 'No key provided' });

  const lic = await License.findOne({ key: key.toUpperCase().trim() });
  if (!lic)                    return res.json({ valid: false, reason: 'invalid' });
  if (lic.status === 'revoked') return res.json({ valid: false, reason: 'revoked' });

  if (lic.status === 'active' && lic.expiresAt < new Date()) {
    lic.status = 'expired';
    await lic.save();
    return res.json({ valid: false, reason: 'expired' });
  }

  if (lic.status === 'expired') return res.json({ valid: false, reason: 'expired' });
  if (lic.status === 'unused')  return res.json({ valid: false, reason: 'not_activated' });

  const msLeft = new Date(lic.expiresAt) - Date.now();
  return res.json({
    valid: true,
    status: 'active',
    expiresAt: lic.expiresAt,
    msLeft,
  });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'License Server Online ✅' }));

// ── Connect & Start ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => {
      console.log(`✅ License API running on port ${PORT}`);
      console.log(`✅ Telegram bot polling started`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    process.exit(1);
  });
