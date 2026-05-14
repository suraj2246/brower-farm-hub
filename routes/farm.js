const express = require('express');
const router  = express.Router();
const farm    = require('../services/browserFarm');
const BrowserProfile = require('../models/BrowserProfile');

// — Profiles —
router.get('/profiles', async (_req, res) => {
  try { res.json(await farm.listProfiles()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profiles', async (req, res) => {
  try {
    const { name, proxyMode, proxy } = req.body;
    if (proxyMode === 'manual' && (!proxy?.host || !proxy?.port)) {
      return res.status(400).json({ error: 'Manual mode: proxy.host and proxy.port required' });
    }
    const profile = await farm.createProfile({ name, proxyMode, proxy });
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/profiles/:id/proxy', async (req, res) => {
  try {
    const { proxyMode, proxy } = req.body;
    const profile = await farm.updateProxy(req.params.id, { proxyMode, proxy });
    res.json({ ok: true, profile });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/profiles/:id', async (req, res) => {
  try { await farm.deleteProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// — Session control —
router.post('/profiles/:id/run', async (req, res) => {
  try {
    farm.runWarmSession(req.params.id).catch(e => console.error('[runWarmSession]', e));
    res.json({ ok: true, message: 'Warm session started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profiles/:id/launch-interactive', async (req, res) => {
  try { res.json(await farm.launchInteractive(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/profiles/:id/stop-interactive', async (req, res) => {
  try { res.json(await farm.stopInteractive(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/profiles/:id/pause',  async (req, res) => {
  try { await farm.pauseProfile(req.params.id);  res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profiles/:id/resume', async (req, res) => {
  try { await farm.resumeProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// — Clear operations: body { what: 'cookies'|'storage'|'browser'|'sessions' } —
router.post('/profiles/:id/clear', async (req, res) => {
  try {
    const { what } = req.body;
    if (!['cookies','storage','browser','sessions'].includes(what)) {
      return res.status(400).json({ error: 'what must be cookies, storage, browser, or sessions' });
    }
    await farm.clearProfile(req.params.id, what);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// — Share links —
router.post('/profiles/:id/share', async (req, res) => {
  try {
    const { password, expiresInHours, label } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const profile = await BrowserProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const expiresAt = expiresInHours ? new Date(Date.now() + Number(expiresInHours) * 3600000) : null;
    const { token } = await profile.addShareLink(password, { expiresAt, label });
    await profile.save();

    const host  = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const url   = `${proto}://${host}/share/${token}`;
    res.json({ ok: true, token, url, expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/profiles/:id/shares', async (req, res) => {
  try {
    const profile = await BrowserProfile.findById(req.params.id).select('shareLinks name');
    if (!profile) return res.status(404).json({ error: 'Not found' });
    const host  = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    res.json({
      shares: profile.shareLinks.map(s => ({
        _id: s._id, token: s.token, label: s.label,
        expiresAt: s.expiresAt, createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt, useCount: s.useCount,
        url: `${proto}://${host}/share/${s.token}`,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/profiles/:id/shares/:shareId', async (req, res) => {
  try {
    const profile = await BrowserProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const before = profile.shareLinks.length;
    profile.shareLinks = profile.shareLinks.filter(s => s._id.toString() !== req.params.shareId);
    if (profile.shareLinks.length === before) return res.status(404).json({ error: 'Share link not found' });
    await profile.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// — Engine API: atomic claim —
router.get('/ready', async (_req, res) => {
  try {
    const profile = await farm.getReadyProfile();
    if (!profile) return res.status(404).json({ error: 'No ready profiles' });
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profiles/:id/mark-used', async (req, res) => {
  try { await farm.markUsed(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profiles/:id/release', async (req, res) => {
  try { await farm.releaseReservation(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// — Stats: one aggregation query —
router.get('/stats', async (_req, res) => {
  try {
    const counts = await BrowserProfile.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const total = counts.reduce((s, c) => s + c.count, 0);
    const by = Object.fromEntries(counts.map(c => [c._id, c.count]));
    res.json({
      total,
      new:         by.new         || 0,
      warming:     by.warming     || 0,
      ready:       by.ready       || 0,
      used:        by.used        || 0,
      error:       by.error       || 0,
      paused:      by.paused      || 0,
      reserved:    by.reserved    || 0,
      interactive: by.interactive || 0,
      active:      farm.getActiveSessions(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/profiles/:id/logs', async (req, res) => {
  try {
    const p = await BrowserProfile.findById(req.params.id).select('logs name');
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ name: p.name, logs: p.logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
