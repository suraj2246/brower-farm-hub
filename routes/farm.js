const express = require('express');
const router  = express.Router();
const farm    = require('../services/browserFarm');
const BrowserProfile = require('../models/BrowserProfile');

// GET /api/farm/profiles
router.get('/profiles', async (req, res) => {
  try { res.json(await farm.listProfiles()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/farm/profiles — create new profile
// Body: { name, proxyMode: 'manual'|'engine', proxy: { protocol, host, port, username, password } }
router.post('/profiles', async (req, res) => {
  try {
    const { name, proxyMode, proxy } = req.body;
    if (proxyMode === 'manual' && (!proxy?.host || !proxy?.port)) {
      return res.status(400).json({ error: 'proxy.host and proxy.port required for manual mode' });
    }
    const profile = await farm.createProfile({ name, proxyMode, proxy });
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/farm/profiles/:id
router.delete('/profiles/:id', async (req, res) => {
  try { await farm.deleteProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/farm/profiles/:id/run — trigger a session immediately
router.post('/profiles/:id/run', async (req, res) => {
  try {
    farm.runWarmSession(req.params.id).catch(console.error); // background
    res.json({ ok: true, message: 'Session started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/farm/profiles/:id/pause
router.post('/profiles/:id/pause', async (req, res) => {
  try { await farm.pauseProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/farm/profiles/:id/resume
router.post('/profiles/:id/resume', async (req, res) => {
  try { await farm.resumeProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/farm/ready — get one ready profile (called by SocialHub Engine)
router.get('/ready', async (req, res) => {
  try {
    const profile = await farm.getReadyProfile();
    if (!profile) return res.status(404).json({ error: 'No ready profiles' });
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/farm/profiles/:id/mark-used — called by engine after consuming profile
router.post('/profiles/:id/mark-used', async (req, res) => {
  try { await farm.markUsed(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/farm/stats
router.get('/stats', async (req, res) => {
  try {
    const all = await BrowserProfile.find({});
    res.json({
      total:    all.length,
      new:      all.filter(p => p.status === 'new').length,
      warming:  all.filter(p => p.status === 'warming').length,
      ready:    all.filter(p => p.status === 'ready').length,
      used:     all.filter(p => p.status === 'used').length,
      error:    all.filter(p => p.status === 'error').length,
      paused:   all.filter(p => p.status === 'paused').length,
      active:   farm.getActiveSessions(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/farm/profiles/:id/logs
router.get('/profiles/:id/logs', async (req, res) => {
  try {
    const p = await BrowserProfile.findById(req.params.id).select('logs name');
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ name: p.name, logs: p.logs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
