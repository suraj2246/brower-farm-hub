const mongoose = require('mongoose');

const BrowserProfileSchema = new mongoose.Schema({

  // ── Identity ────────────────────────────────────────────────────────────────
  name: { type: String, default: () => 'Farm-' + Date.now() },

  // ── Status flow: new → warming → ready → used ───────────────────────────────
  status: {
    type: String,
    enum: ['new', 'warming', 'ready', 'used', 'error', 'paused'],
    default: 'new',
  },
  statusDetail: { type: String, default: '' },

  // ── Proxy config ─────────────────────────────────────────────────────────────
  // proxyMode: 'manual' = user entered proxy directly in farm dashboard
  //            'engine' = pull from SocialHub Engine proxy pool via API
  proxyMode: { type: String, enum: ['manual', 'engine'], default: 'manual' },
  proxy: {
    protocol: { type: String, default: 'socks5' },
    host:     { type: String, default: '' },
    port:     { type: Number, default: 0 },
    username: { type: String, default: '' },
    password: { type: String, default: '' },
    // If mode=engine: which proxy _id was assigned from the engine
    engineProxyId: { type: String, default: null },
  },

  // ── Fingerprint (locked at creation — same every session) ───────────────────
  fingerprint: {
    userAgent:    { type: String, default: '' },
    viewport:     { width: Number, height: Number },
    timezone:     { type: String, default: 'America/New_York' },
    locale:       { type: String, default: 'en-US' },
    platform:     { type: String, default: 'Win32' },
    cpuCores:     { type: Number, default: 4 },
    deviceMem:    { type: Number, default: 8 },
    webglVendor:  { type: String, default: '' },
    webglRenderer:{ type: String, default: '' },
    canvasSeed:   { type: Number, default: 0 },
    audioSeed:    { type: Number, default: 0 },
    chromeVersion:{ type: String, default: '135' },
  },

  // ── Warming stats ────────────────────────────────────────────────────────────
  daysWarmed:         { type: Number, default: 0 },
  sessionsCompleted:  { type: Number, default: 0 },
  lastSessionAt:      { type: Date,   default: null },
  fbpCookieSetAt:     { type: Date,   default: null }, // when _fbp was first set
  fbpCookieAge:       { type: Number, default: 0 },    // days since _fbp was set

  // ── Session storage ──────────────────────────────────────────────────────────
  // Stored as JSON string — applied to browser context on each warm session
  sessionData: { type: String, default: null },

  // ── Logs (last 100 lines) ────────────────────────────────────────────────────
  logs: [{
    level:   String,
    msg:     String,
    time:    { type: Date, default: Date.now },
  }],

  // ── Error tracking ───────────────────────────────────────────────────────────
  lastError:        { type: String, default: '' },
  proxyKillCount:   { type: Number, default: 0 }, // times killed due to proxy drop

  // ── Timestamps ───────────────────────────────────────────────────────────────
  createdAt:    { type: Date, default: Date.now },
  readyAt:      { type: Date, default: null },
  usedAt:       { type: Date, default: null },

}, { timestamps: false });

// ── Computed: is this profile ready to use? ───────────────────────────────────
BrowserProfileSchema.methods.isReadyToUse = function () {
  if (this.status !== 'ready') return false;
  if (!this.fbpCookieSetAt) return false;
  const ageDays = (Date.now() - this.fbpCookieSetAt.getTime()) / 86400000;
  return ageDays >= 2 && this.daysWarmed >= 2;
};

// ── Add a log line (trims to 100 entries) ────────────────────────────────────
BrowserProfileSchema.methods.addLog = function (level, msg) {
  this.logs.push({ level, msg, time: new Date() });
  if (this.logs.length > 100) this.logs = this.logs.slice(-100);
};

// ── Build proxy URL string ────────────────────────────────────────────────────
BrowserProfileSchema.methods.getProxyUrl = function () {
  const p = this.proxy;
  if (!p || !p.host || !p.port) return null;
  if (p.username && p.password) {
    return `${p.protocol}://${p.username}:${p.password}@${p.host}:${p.port}`;
  }
  return `${p.protocol}://${p.host}:${p.port}`;
};

module.exports = mongoose.model('BrowserProfile', BrowserProfileSchema);
