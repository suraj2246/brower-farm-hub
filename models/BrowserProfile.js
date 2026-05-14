const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const ShareLinkSchema = new mongoose.Schema({
  token:        { type: String, required: true },
  passwordHash: { type: String, required: true },
  expiresAt:    { type: Date,   default: null }, // null = never expires
  createdAt:    { type: Date,   default: Date.now },
  lastUsedAt:   { type: Date,   default: null },
  useCount:     { type: Number, default: 0 },
  label:        { type: String, default: '' },
}, { _id: true });

const BrowserProfileSchema = new mongoose.Schema({
  name: { type: String, default: () => 'Farm-' + Date.now() },

  status: {
    type: String,
    enum: ['new','warming','ready','used','error','paused','reserved','interactive'],
    default: 'new',
  },
  statusDetail: { type: String, default: '' },

  proxyMode: { type: String, enum: ['manual','engine'], default: 'manual' },
  proxy: {
    protocol:      { type: String, default: 'socks5' },
    host:          { type: String, default: '' },
    port:          { type: Number, default: 0 },
    username:      { type: String, default: '' },
    password:      { type: String, default: '' },
    engineProxyId: { type: String, default: null },
  },

  fingerprint: {
    userAgent:     { type: String, default: '' },
    viewport:      { width: Number, height: Number },
    timezone:      { type: String, default: 'America/New_York' },
    locale:        { type: String, default: 'en-US' },
    platform:      { type: String, default: 'Win32' },
    cpuCores:      { type: Number, default: 4 },
    deviceMem:     { type: Number, default: 8 },
    webglVendor:   { type: String, default: '' },
    webglRenderer: { type: String, default: '' },
    canvasSeed:    { type: Number, default: 0 },
    audioSeed:     { type: Number, default: 0 },
    chromeVersion: { type: String, default: '135' },
    gpuClass:      { type: String, default: 'nvidia' },
  },

  daysWarmed:        { type: Number, default: 0 },
  sessionsCompleted: { type: Number, default: 0 },
  warmDates:         { type: [String], default: [] }, // YYYY-MM-DD strings — actual session days
  lastSessionAt:     { type: Date, default: null },
  fbpCookieSetAt:    { type: Date, default: null },
  fbpCookieAge:      { type: Number, default: 0 },

  sessionData: { type: String, default: null }, // backup snapshot (used only if disk profile is wiped)

  logs: [{
    level: String,
    msg:   String,
    time:  { type: Date, default: Date.now },
  }],

  lastError:      { type: String, default: '' },
  proxyKillCount: { type: Number, default: 0 },

  autoDeleteDays: { type: Number, default: 0 }, // 0 = never auto-delete (always 0 per your preference)

  interactive: {
    active:    { type: Boolean, default: false },
    startedAt: { type: Date,    default: null },
  },

  shareLinks: { type: [ShareLinkSchema], default: [] },

  reservedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  readyAt:   { type: Date, default: null },
  usedAt:    { type: Date, default: null },
}, { timestamps: false });

BrowserProfileSchema.index({ status: 1, reservedAt: 1 });
BrowserProfileSchema.index({ 'shareLinks.token': 1 });

BrowserProfileSchema.methods.addLog = function (level, msg) {
  this.logs.push({ level, msg, time: new Date() });
  if (this.logs.length > 200) this.logs = this.logs.slice(-200);
};

BrowserProfileSchema.methods.recordSessionDay = function () {
  const today = new Date().toISOString().substring(0, 10);
  if (!this.warmDates.includes(today)) this.warmDates.push(today);
  if (this.warmDates.length > 365) this.warmDates = this.warmDates.slice(-365);
};

BrowserProfileSchema.methods.addShareLink = async function (password, opts = {}) {
  if (!password || password.length < 4) throw new Error('Password must be at least 4 characters');
  const { nanoid } = require('nanoid');
  const token = nanoid(24);
  const passwordHash = await bcrypt.hash(password, 10);
  this.shareLinks.push({
    token,
    passwordHash,
    expiresAt: opts.expiresAt || null,
    label: opts.label || '',
  });
  return { token };
};

BrowserProfileSchema.methods.verifyShareLink = async function (token, password) {
  const link = this.shareLinks.find(l => l.token === token);
  if (!link) return { ok: false, reason: 'Invalid token' };
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'Link expired' };
  const match = await bcrypt.compare(password, link.passwordHash);
  if (!match) return { ok: false, reason: 'Wrong password' };
  link.lastUsedAt = new Date();
  link.useCount++;
  return { ok: true, link };
};

module.exports = mongoose.model('BrowserProfile', BrowserProfileSchema);
