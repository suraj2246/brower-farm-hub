/**
 * browserFarm.js — Browser Warming Engine
 *
 * Manages all BrowserProfile warming sessions.
 * Each profile runs 3 sessions/day (morning, lunch, evening).
 *
 * Day 1: General browsing → visit facebook.com as guest (sets _fbp cookie)
 * Day 2+: More browsing, profile check, consistent patterns
 * After 2 days + _fbp age ≥ 2 days → status = 'ready'
 *
 * PROXY RULE: Browser NEVER opens without a working proxy.
 * If proxy dies mid-session → kill switch closes context immediately.
 */

const BrowserProfile = require('../models/BrowserProfile');
const farmBrowser    = require('./farmBrowser');
const proxyMonitor   = require('./proxyMonitor');
const axios          = require('axios');

const { launchFarmBrowser, saveSession, startScreencast, humanMove, sleep, randInt, rand } = farmBrowser;

const FB = 'https://www.facebook.com';

// ── Active sessions map: profileId → { context, page, stopCast, stopMonitor } ─
const _activeSessions = new Map();
let _io = null;
const setIo = (io) => { _io = io; };

const emit = (event, data) => { if (_io) _io.emit(event, data); };

// ── Fetch proxy from SocialHub Engine ─────────────────────────────────────────
const fetchEngineProxy = async () => {
  const url = process.env.ENGINE_URL;
  const key = process.env.ENGINE_API_KEY;
  if (!url || !key) throw new Error('ENGINE_URL or ENGINE_API_KEY not set');

  const res = await axios.get(`${url}/api/proxies?limit=1&status=active`, {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 8000,
  });
  const proxies = res.data?.proxies || res.data;
  if (!proxies || proxies.length === 0) throw new Error('No active proxies in engine');
  const p = proxies[0];
  return {
    protocol:       p.protocol || 'socks5',
    host:           p.host,
    port:           p.port,
    username:       p.username || '',
    password:       p.password || '',
    engineProxyId:  p._id,
  };
};

// ── Log helper ────────────────────────────────────────────────────────────────
const logProfile = async (profile, level, msg) => {
  console.log(`[Farm:${profile._id}] [${level}] ${msg}`);
  profile.addLog(level, msg);
  emit('farm_log', { profileId: profile._id.toString(), level, msg, time: new Date() });
};

// ── Emit profile state update ─────────────────────────────────────────────────
const emitProfile = (profile) => {
  emit('profile_update', {
    _id:              profile._id.toString(),
    name:             profile.name,
    status:           profile.status,
    statusDetail:     profile.statusDetail,
    daysWarmed:       profile.daysWarmed,
    sessionsCompleted:profile.sessionsCompleted,
    fbpCookieAge:     profile.fbpCookieAge,
    lastSessionAt:    profile.lastSessionAt,
    proxyMode:        profile.proxyMode,
    proxyHost:        profile.proxy?.host || '',
    isLive:           _activeSessions.has(profile._id.toString()),
  });
};

// ── Human browsing simulation ─────────────────────────────────────────────────
const browseWebsite = async (page, url, durationMs, log) => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randInt(2000, 4000));

    const end = Date.now() + durationMs;
    let scrolls = 0;

    while (Date.now() < end) {
      // Scroll down naturally
      await page.mouse.wheel(0, randInt(200, 500));
      await sleep(randInt(1500, 3500));

      // Occasionally move mouse as if reading
      if (Math.random() < 0.4) {
        await humanMove(page, randInt(200, 900), randInt(200, 600));
        await sleep(randInt(500, 1200));
      }

      // Occasionally scroll back up slightly
      if (Math.random() < 0.25) {
        await page.mouse.wheel(0, -randInt(100, 250));
        await sleep(randInt(800, 1500));
      }

      scrolls++;
    }

    log('info', `Browsed ${url} — ${scrolls} scroll events`);
    return true;
  } catch (e) {
    log('warning', `Browse ${url} failed: ${e.message}`);
    return false;
  }
};

// ── Run a single warming session ──────────────────────────────────────────────
const runWarmSession = async (profileId) => {
  const profile = await BrowserProfile.findById(profileId);
  if (!profile) return;
  if (_activeSessions.has(profileId.toString())) {
    console.log(`[Farm] Session already running for ${profileId}`);
    return;
  }

  const log = (level, msg) => logProfile(profile, level, msg);

  // ── Resolve proxy ────────────────────────────────────────────────────────────
  let proxyData;
  try {
    if (profile.proxyMode === 'engine') {
      log('info', 'Fetching proxy from SocialHub Engine...');
      proxyData = await fetchEngineProxy();
      profile.proxy = proxyData;
    } else {
      proxyData = profile.proxy;
    }

    if (!proxyData?.host || !proxyData?.port) {
      throw new Error('No proxy configured — browser will not launch without proxy');
    }
  } catch (e) {
    log('error', `Proxy error: ${e.message}`);
    profile.status       = 'error';
    profile.statusDetail = e.message;
    profile.lastError    = e.message;
    await profile.save();
    emitProfile(profile);
    return;
  }

  // ── Verify proxy BEFORE launching ────────────────────────────────────────────
  log('info', `Verifying proxy ${proxyData.host}:${proxyData.port}...`);
  const check = await proxyMonitor.verifyProxy(proxyData);
  if (!check.ok) {
    log('error', `Proxy dead before launch: ${check.error} — ABORTING`);
    profile.status       = 'error';
    profile.statusDetail = `Proxy unreachable: ${check.error}`;
    profile.lastError    = check.error;
    await profile.save();
    emitProfile(profile);
    return;
  }
  log('info', `Proxy verified — IP: ${check.ip}`);

  // ── Launch browser ────────────────────────────────────────────────────────────
  profile.status       = 'warming';
  profile.statusDetail = 'Session starting...';
  await profile.save();
  emitProfile(profile);

  let context, page, fp, proxyCleanup, stopCast, stopMonitor;

  try {
    log('info', 'Launching stealth browser...');
    const launched = await launchFarmBrowser(profile);
    context      = launched.context;
    page         = launched.page;
    fp           = launched.fp;
    proxyCleanup = launched.cleanup;

    // Save fingerprint back to profile if first time
    if (!profile.fingerprint?.userAgent) {
      profile.fingerprint = fp;
    }

    // ── Start proxy kill switch ──────────────────────────────────────────────
    stopMonitor = proxyMonitor.startMonitor(proxyData, async (reason) => {
      log('error', `PROXY KILLED: ${reason}`);
      profile.proxyKillCount++;
      profile.statusDetail = `Proxy dropped — ${reason}`;
      await profile.save().catch(() => {});
      emitProfile(profile);
      // Close browser immediately — no bare-IP requests allowed
      await context.close().catch(() => {});
      _activeSessions.delete(profileId.toString());
      emit('session_killed', { profileId: profileId.toString(), reason });
    }, log);

    // ── Start live screencast ────────────────────────────────────────────────
    stopCast = await startScreencast(page, (frame) => {
      emit('farm_frame', { profileId: profileId.toString(), frame });
    });

    _activeSessions.set(profileId.toString(), { context, page, stopCast, stopMonitor });
    emit('session_started', { profileId: profileId.toString() });

    const isFirstSession = profile.sessionsCompleted === 0;
    const isDay1 = profile.daysWarmed === 0;

    // ═══════════════════════════════════════════════════════════════════════════
    // WARMING SESSION CONTENT
    // ═══════════════════════════════════════════════════════════════════════════

    // ── Phase 1: Build browser history on neutral sites ──────────────────────
    log('info', 'Phase 1: Browsing neutral sites...');
    profile.statusDetail = 'Phase 1: Browsing news sites...';
    await profile.save(); emitProfile(profile);

    const newsSites = [
      'https://www.bbc.com',
      'https://www.reuters.com',
      'https://www.cnn.com',
      'https://www.theguardian.com',
    ];

    // Browse 2-3 news sites
    const sitesToBrowse = rand(newsSites.length === 4 ? [2, 3] : [2]);
    for (let i = 0; i < sitesToBrowse; i++) {
      const site = rand(newsSites);
      log('info', `Browsing: ${site}`);
      await browseWebsite(page, site, randInt(25000, 45000), log);
      await sleep(randInt(3000, 6000));
    }

    // ── Phase 2: YouTube (builds watch history signal) ───────────────────────
    if (Math.random() < 0.7) {
      log('info', 'Phase 2: YouTube browsing...');
      profile.statusDetail = 'Phase 2: YouTube...';
      await profile.save(); emitProfile(profile);
      await browseWebsite(page, 'https://www.youtube.com', randInt(30000, 50000), log);
      await sleep(randInt(3000, 5000));
    }

    // ── Phase 3: Facebook visit (CRITICAL — sets _fbp cookie) ───────────────
    log('info', 'Phase 3: Visiting Facebook as guest...');
    profile.statusDetail = 'Phase 3: Setting _fbp cookie on Facebook...';
    await profile.save(); emitProfile(profile);

    try {
      // Visit FB home — don't log in, just let it set cookies
      await page.goto(FB, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(randInt(4000, 7000));

      // Check if _fbp cookie was set
      const cookies = await context.cookies(['https://www.facebook.com']);
      const fbp     = cookies.find(c => c.name === '_fbp');
      if (fbp) {
        if (!profile.fbpCookieSetAt) {
          profile.fbpCookieSetAt = new Date();
          log('success', '_fbp cookie SET — aging clock started');
        } else {
          const ageDays = (Date.now() - profile.fbpCookieSetAt.getTime()) / 86400000;
          profile.fbpCookieAge = Math.round(ageDays * 10) / 10;
          log('info', `_fbp cookie age: ${profile.fbpCookieAge} days`);
        }
      }

      // Browse FB briefly as a guest (scroll the login page)
      await page.mouse.wheel(0, randInt(200, 400));
      await sleep(randInt(3000, 6000));
      await humanMove(page, randInt(300, 700), randInt(200, 500));
      await sleep(randInt(2000, 4000));

      log('info', 'Facebook visit complete');
    } catch (e) {
      log('warning', `Facebook visit failed: ${e.message}`);
    }

    // ── Phase 4: Google search (builds referrer + search history) ────────────
    if (Math.random() < 0.6) {
      log('info', 'Phase 4: Bing search session...');
      profile.statusDetail = 'Phase 4: Search engine session...';
      await profile.save(); emitProfile(profile);
      // Bing over Google — SOCKS5 IPs are heavily flagged by Google
      await browseWebsite(page, 'https://www.bing.com', randInt(20000, 35000), log);
    }

    // ── Phase 5: Return to FB and idle ────────────────────────────────────────
    if (!isDay1 || profile.sessionsCompleted > 1) {
      log('info', 'Phase 5: Final FB idle visit...');
      profile.statusDetail = 'Phase 5: Final Facebook idle...';
      await profile.save(); emitProfile(profile);
      try {
        await page.goto(FB, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(randInt(5000, 10000));
      } catch {}
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // END OF SESSION — save state
    // ═══════════════════════════════════════════════════════════════════════════

    log('info', 'Saving session state...');
    const sessionData = await saveSession(context);
    profile.sessionData = sessionData;

    profile.sessionsCompleted++;
    profile.lastSessionAt = new Date();

    // Update days warmed (count unique calendar days with sessions)
    profile.daysWarmed = Math.max(
      profile.daysWarmed,
      Math.floor((Date.now() - profile.createdAt.getTime()) / 86400000)
    );

    // Update _fbp age
    if (profile.fbpCookieSetAt) {
      profile.fbpCookieAge = Math.round(
        ((Date.now() - profile.fbpCookieSetAt.getTime()) / 86400000) * 10
      ) / 10;
    }

    // Check if ready
    const isReady = profile.fbpCookieSetAt &&
      profile.fbpCookieAge >= 2 &&
      profile.daysWarmed >= 2 &&
      profile.sessionsCompleted >= 4;

    if (isReady && profile.status !== 'ready') {
      profile.status       = 'ready';
      profile.statusDetail = `Ready after ${profile.daysWarmed} days, ${profile.sessionsCompleted} sessions`;
      profile.readyAt      = new Date();
      log('success', '🟢 Profile is READY to use!');
      emit('profile_ready', { profileId: profileId.toString() });
    } else {
      profile.status       = 'warming';
      profile.statusDetail = `Day ${profile.daysWarmed} — ${profile.sessionsCompleted} sessions — _fbp: ${profile.fbpCookieAge} days`;
    }

    await profile.save();
    log('success', `Session complete — ${profile.sessionsCompleted} total sessions`);

  } catch (e) {
    log('error', `Session error: ${e.message}`);
    profile.status       = 'error';
    profile.statusDetail = e.message;
    profile.lastError    = e.message;
    await profile.save();
  } finally {
    if (stopCast)    await stopCast().catch(() => {});
    if (stopMonitor) stopMonitor();
    if (context)     await context.close().catch(() => {});
    if (proxyCleanup) await proxyCleanup().catch(() => {});
    _activeSessions.delete(profileId.toString());
    emitProfile(profile);
    emit('session_ended', { profileId: profileId.toString() });
  }
};

// ── Create a new profile ──────────────────────────────────────────────────────
const createProfile = async ({ name, proxyMode, proxy }) => {
  const profile = new BrowserProfile({
    name:      name || `Farm-${Date.now()}`,
    proxyMode: proxyMode || 'manual',
    proxy:     proxy || {},
    status:    'new',
  });
  await profile.save();
  emitProfile(profile);
  return profile;
};

// ── Get a ready profile for use by SocialHub Engine ──────────────────────────
const getReadyProfile = async () => {
  const profile = await BrowserProfile.findOne({
    status: 'ready',
    'fbpCookieAge': { $gte: 2 },
    daysWarmed: { $gte: 2 },
  }).sort({ fbpCookieAge: -1 });
  return profile;
};

// ── Mark a profile as used ────────────────────────────────────────────────────
const markUsed = async (profileId) => {
  await BrowserProfile.findByIdAndUpdate(profileId, {
    status: 'used',
    usedAt: new Date(),
    statusDetail: 'Consumed by account creator',
  });
};

// ── List all profiles ─────────────────────────────────────────────────────────
const listProfiles = async () => {
  const profiles = await BrowserProfile.find({}).sort({ createdAt: -1 }).lean();
  return profiles.map(p => ({
    ...p,
    isLive: _activeSessions.has(p._id.toString()),
  }));
};

// ── Delete a profile ──────────────────────────────────────────────────────────
const deleteProfile = async (profileId) => {
  const session = _activeSessions.get(profileId.toString());
  if (session) {
    session.stopCast?.().catch(() => {});
    session.stopMonitor?.();
    await session.context?.close().catch(() => {});
    _activeSessions.delete(profileId.toString());
  }
  await BrowserProfile.findByIdAndDelete(profileId);
  emit('profile_deleted', { profileId: profileId.toString() });
};

// ── Pause / resume ────────────────────────────────────────────────────────────
const pauseProfile = async (profileId) => {
  await BrowserProfile.findByIdAndUpdate(profileId, { status: 'paused', statusDetail: 'Paused by user' });
  const profile = await BrowserProfile.findById(profileId);
  if (profile) emitProfile(profile);
};
const resumeProfile = async (profileId) => {
  await BrowserProfile.findByIdAndUpdate(profileId, { status: 'warming', statusDetail: 'Resumed' });
  // Will be picked up by next scheduler run
};

// ── Get active session count ──────────────────────────────────────────────────
const getActiveSessions = () => _activeSessions.size;

// ── Scheduler — fires warming sessions 3x/day ────────────────────────────────
// Targets: 9:00, 13:00, 19:00 (spread out naturally)
// Uses cron but also runs immediately at startup for any due profiles
const startScheduler = () => {
  const cron = require('node-cron');

  const runDueProfiles = async () => {
    const profiles = await BrowserProfile.find({
      status: { $in: ['new', 'warming'] },
    });

    for (const profile of profiles) {
      if (_activeSessions.has(profile._id.toString())) continue;

      const lastSession = profile.lastSessionAt;
      const now = Date.now();

      // Don't run if last session was less than 3 hours ago
      if (lastSession && (now - lastSession.getTime()) < 3 * 60 * 60 * 1000) continue;

      console.log(`[Farm] Scheduling session for profile: ${profile.name}`);
      // Run in background — don't await
      runWarmSession(profile._id.toString()).catch(console.error);

      // Stagger starts by 30s each so they don't all hammer the same time
      await sleep(30000);
    }
  };

  // 9am, 1pm, 7pm
  cron.schedule('0 9 * * *',  runDueProfiles);
  cron.schedule('0 13 * * *', runDueProfiles);
  cron.schedule('0 19 * * *', runDueProfiles);

  // On startup: run any profiles that haven't had a session in 4+ hours
  setTimeout(runDueProfiles, 5000);

  console.log('[Farm] Scheduler started — 3 sessions/day per profile');
};

module.exports = {
  createProfile, getReadyProfile, markUsed,
  listProfiles, deleteProfile, pauseProfile, resumeProfile,
  runWarmSession, startScheduler, getActiveSessions, setIo,
};
