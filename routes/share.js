const express = require('express');
const router  = express.Router();
const path    = require('path');
const BrowserProfile = require('../models/BrowserProfile');
const { createShareSession } = require('../services/shareSessions');

// Serve the share viewer page (renders even before auth — JS prompts for password)
router.get('/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'share.html'));
});

// Authenticate with password — returns a short-lived session token used for socket auth
router.post('/:token/auth', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });

    const profile = await BrowserProfile.findOne({ 'shareLinks.token': req.params.token });
    if (!profile) return res.status(404).json({ error: 'Invalid link' });

    const v = await profile.verifyShareLink(req.params.token, password);
    if (!v.ok) return res.status(401).json({ error: v.reason });
    await profile.save();

    // Check the profile is actually in interactive mode
    const isInteractive = !!profile.interactive?.active;

    const { sessionToken, expiresAt } = createShareSession(profile._id.toString(), req.params.token);
    res.json({
      ok: true,
      sessionToken,
      profileId:      profile._id.toString(),
      profileName:    profile.name,
      isInteractive,
      viewportWidth:  profile.fingerprint?.viewport?.width  || 1366,
      viewportHeight: profile.fingerprint?.viewport?.height || 800,
      expiresAt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
