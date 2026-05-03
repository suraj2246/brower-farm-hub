/**
 * browserFarm.js — Browser Warming Engine
 * Deep activity logging on every function + Invalid URL fix.
 */

const BrowserProfile = require('../models/BrowserProfile');
const farmBrowser    = require('./farmBrowser');
const proxyMonitor   = require('./proxyMonitor');
const axios          = require('axios');

const { launchFarmBrowser, saveSession, startScreencast, humanMove, sleep, randInt, rand } = farmBrowser;

const FB = 'https://www.facebook.com';

const _activeSessions = new Map();
let _io = null;
const setIo = (io) => { _io = io; };
const emit  = (event, data) => { if (_io) _io.emit(event, data); };

// ── Timestamp helpers ─────────────────────────────────────────────────────────
const ts      = () => new Date().toISOString().replace('T',' ').substring(0,19);
const elapsed = (start) => `+${((Date.now()-start)/1000).toFixed(1)}s`;

// ── Log helper — saves to DB + emits to dashboard ─────────────────────────────
const logProfile = async (profile, level, msg) => {
  const line = `[${ts()}] ${msg}`;
  console.log(`[Farm:${profile.name}] [${level.toUpperCase()}] ${msg}`);
  profile.addLog(level, line);
  emit('farm_log', { profileId: profile._id.toString(), level, msg: line, time: new Date() });
};

// ── Emit profile card update ──────────────────────────────────────────────────
const emitProfile = (profile) => {
  emit('profile_update', {
    _id:               profile._id.toString(),
    name:              profile.name,
    status:            profile.status,
    statusDetail:      profile.statusDetail,
    daysWarmed:        profile.daysWarmed,
    sessionsCompleted: profile.sessionsCompleted,
    fbpCookieAge:      profile.fbpCookieAge,
    lastSessionAt:     profile.lastSessionAt,
    proxyMode:         profile.proxyMode,
    proxyHost:         profile.proxy?.host || '',
    isLive:            _activeSessions.has(profile._id.toString()),
  });
};

const setStatus = async (profile, detail) => {
  profile.statusDetail = detail;
  await profile.save();
  emitProfile(profile);
};

// ── Fetch proxy from SocialHub Engine ─────────────────────────────────────────
const fetchEngineProxy = async (log) => {
  const url = (process.env.ENGINE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.ENGINE_API_KEY || '').trim();

  log('info', `fetchEngineProxy() — ENGINE_URL: "${url || '(not set)'}"`);

  if (!url) throw new Error('ENGINE_URL env var not set in Railway — add it in Variables tab');
  if (!key) throw new Error('ENGINE_API_KEY env var not set in Railway — add it in Variables tab');

  try { new URL(url); } catch {
    throw new Error(`ENGINE_URL is invalid: "${url}" — must be like https://your-engine.railway.app`);
  }

  const endpoint = `${url}/api/proxies?limit=1&status=active`;
  log('info', `Calling engine: GET ${endpoint}`);

  const res = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 10000,
  });

  log('info', `Engine response: ${res.status} — ${JSON.stringify(res.data).substring(0, 120)}`);

  const proxies = res.data?.proxies || res.data;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    throw new Error('Engine returned no active proxies — add a proxy in SocialHub Engine first');
  }

  const p = proxies[0];
  log('success', `Got proxy from engine: ${p.protocol}://${p.host}:${p.port}`);
  return { protocol: p.protocol || 'socks5', host: p.host, port: p.port, username: p.username || '', password: p.password || '', engineProxyId: p._id };
};

// ── Human browsing simulation ─────────────────────────────────────────────────
const browseWebsite = async (page, url, durationMs, log, sessionStart) => {
  const siteStart = Date.now();
  log('info', `→ Navigating: ${url} (budget: ${Math.round(durationMs/1000)}s) ${elapsed(sessionStart)}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const loadTime = Date.now() - siteStart;
    const title = await page.title().catch(() => '?');
    log('info', `  Loaded in ${loadTime}ms — "${title.substring(0,50)}"`);
    await sleep(randInt(2000, 4000));

    const end = Date.now() + durationMs;
    let scrolls = 0, moves = 0, backs = 0;
    while (Date.now() < end) {
      await page.mouse.wheel(0, randInt(200, 500)); scrolls++;
      await sleep(randInt(1500, 3500));
      if (Math.random() < 0.4) { await humanMove(page, randInt(200,900), randInt(200,600)); await sleep(randInt(500,1200)); moves++; }
      if (Math.random() < 0.25) { await page.mouse.wheel(0, -randInt(100,250)); await sleep(randInt(800,1500)); backs++; }
    }
    const spent = Math.round((Date.now()-siteStart)/1000);
    log('success', `  ✓ ${url} — ${spent}s | ${scrolls} scrolls | ${moves} moves | ${backs} backs`);
    return true;
  } catch (e) {
    log('warning', `  ✗ Failed ${url}: ${e.message}`);
    return false;
  }
};

// ── Main warm session ─────────────────────────────────────────────────────────
const runWarmSession = async (profileId) => {
  const sessionStart = Date.now();
  const profile = await BrowserProfile.findById(profileId);
  if (!profile) { console.log(`[Farm] Profile ${profileId} not found`); return; }
  if (_activeSessions.has(profileId.toString())) { console.log(`[Farm] Already running: ${profile.name}`); return; }

  const log = (level, msg) => logProfile(profile, level, msg);

  log('info', '══════════════════════════════════════════════');
  log('info', `SESSION START — "${profile.name}"`);
  log('info', `Session #${profile.sessionsCompleted + 1} | Day ${profile.daysWarmed} | Mode: ${profile.proxyMode.toUpperCase()}`);
  log('info', '══════════════════════════════════════════════');

  // ── STEP 1: Resolve proxy ─────────────────────────────────────────────────
  log('info', `[STEP 1/7] Resolving proxy... ${elapsed(sessionStart)}`);
  let proxyData;
  try {
    if (profile.proxyMode === 'engine') {
      log('info', '  Mode=ENGINE → fetching from SocialHub Engine API');
      proxyData = await fetchEngineProxy(log);
      profile.proxy = proxyData;
      await profile.save();
    } else {
      proxyData = profile.proxy;
      log('info', `  Mode=MANUAL → ${proxyData?.host}:${proxyData?.port}`);
    }
    if (!proxyData?.host || !proxyData?.port) throw new Error('Proxy host/port missing — configure proxy in profile');
    log('success', `  ✓ Proxy: ${proxyData.protocol}://${proxyData.host}:${proxyData.port} auth:${!!(proxyData.username)} ${elapsed(sessionStart)}`);
  } catch (e) {
    log('error', `  ✗ STEP 1 FAILED: ${e.message}`);
    profile.status = 'error'; profile.statusDetail = e.message; profile.lastError = e.message;
    await profile.save(); emitProfile(profile); return;
  }

  // ── STEP 2: Verify proxy alive ────────────────────────────────────────────
  log('info', `[STEP 2/7] Pinging proxy... ${elapsed(sessionStart)}`);
  await setStatus(profile, 'Step 2/7: Verifying proxy...');
  const check = await proxyMonitor.verifyProxy(proxyData);
  if (!check.ok) {
    log('error', `  ✗ STEP 2 FAILED: ${check.error} — ABORTING (no bare-IP launch)`);
    profile.status = 'error'; profile.statusDetail = `Proxy dead: ${check.error}`; profile.lastError = check.error;
    await profile.save(); emitProfile(profile); return;
  }
  log('success', `  ✓ Proxy alive — external IP: ${check.ip} ${elapsed(sessionStart)}`);

  // ── STEP 3: Launch browser ────────────────────────────────────────────────
  log('info', `[STEP 3/7] Launching stealth browser... ${elapsed(sessionStart)}`);
  await setStatus(profile, 'Step 3/7: Launching browser...');
  profile.status = 'warming'; await profile.save(); emitProfile(profile);

  let context, page, fp, proxyCleanup, stopCast, stopMonitor;
  try {
    const launched = await launchFarmBrowser(profile);
    context = launched.context; page = launched.page; fp = launched.fp; proxyCleanup = launched.cleanup;
    if (!profile.fingerprint?.userAgent) {
      profile.fingerprint = fp; await profile.save();
      log('info', `  Fingerprint locked: Chrome ${fp.chromeVersion} | ${fp.platform} | ${fp.viewport.width}x${fp.viewport.height} | TZ: ${fp.timezone}`);
    } else {
      log('info', `  Reusing fingerprint: Chrome ${fp.chromeVersion}`);
    }
    log('success', `  ✓ Browser launched ${elapsed(sessionStart)}`);
    log('info', `    UA: ${fp.userAgent.substring(0,70)}...`);

    // ── STEP 4: Kill switch + screencast ─────────────────────────────────
    log('info', `[STEP 4/7] Starting kill switch & screencast... ${elapsed(sessionStart)}`);
    stopMonitor = proxyMonitor.startMonitor(proxyData, async (reason) => {
      log('error', `  ⚡ KILL SWITCH TRIGGERED: ${reason}`);
      log('error', '  Closing browser — no bare-IP traffic allowed');
      profile.proxyKillCount++; profile.statusDetail = `Killed: ${reason}`;
      await profile.save().catch(() => {}); emitProfile(profile);
      await context.close().catch(() => {});
      _activeSessions.delete(profileId.toString());
      emit('session_killed', { profileId: profileId.toString(), reason });
    }, log);
    log('info', '  Kill switch active — ping every 30s');

    stopCast = await startScreencast(page, (frame) => emit('farm_frame', { profileId: profileId.toString(), frame }));
    log('info', '  Live screencast active');
    _activeSessions.set(profileId.toString(), { context, page, stopCast, stopMonitor });
    emit('session_started', { profileId: profileId.toString() });

    const isDay1 = profile.daysWarmed === 0;

    // ── STEP 5: Browse news sites ─────────────────────────────────────────
    log('info', `[STEP 5/7] Browsing neutral sites... ${elapsed(sessionStart)}`);
    await setStatus(profile, 'Step 5/7: Browsing news sites...');
    const newsSites = ['https://www.bbc.com','https://www.reuters.com','https://www.theguardian.com','https://www.cnn.com','https://www.npr.org'];
    const picks = newsSites.sort(() => Math.random()-0.5).slice(0, randInt(2, 3));
    log('info', `  Sites picked: ${picks.join(', ')}`);
    for (const site of picks) { await browseWebsite(page, site, randInt(25000,40000), log, sessionStart); await sleep(randInt(3000,6000)); }
    if (Math.random() < 0.7) { log('info', '  + YouTube session'); await browseWebsite(page, 'https://www.youtube.com', randInt(25000,40000), log, sessionStart); }

    // ── STEP 6: Facebook guest visit ──────────────────────────────────────
    log('info', `[STEP 6/7] Facebook guest visit — setting _fbp cookie... ${elapsed(sessionStart)}`);
    await setStatus(profile, 'Step 6/7: Setting Facebook _fbp cookie...');
    try {
      await page.goto(FB, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const title = await page.title().catch(()=>'?');
      log('info', `  FB loaded — title: "${title}"`);
      await sleep(randInt(3000,5000));

      const cookies = await context.cookies(['https://www.facebook.com']);
      log('info', `  FB cookies found: ${cookies.map(c=>c.name).join(', ')||'none'}`);
      const fbp = cookies.find(c => c.name === '_fbp');

      if (fbp) {
        if (!profile.fbpCookieSetAt) {
          profile.fbpCookieSetAt = new Date();
          log('success', `  ✓ _fbp cookie SET — aging clock started!`);
          log('info', `    Value: ${fbp.value.substring(0,40)}...`);
        } else {
          const ageDays = (Date.now() - profile.fbpCookieSetAt.getTime()) / 86400000;
          profile.fbpCookieAge = Math.round(ageDays * 10) / 10;
          log('success', `  ✓ _fbp age: ${profile.fbpCookieAge} / 2.0 days needed`);
        }
      } else {
        log('warning', '  ✗ _fbp NOT found — FB may be blocking or bot detected');
      }

      const fbScrolls = randInt(3,6);
      for (let i=0; i<fbScrolls; i++) { await page.mouse.wheel(0, randInt(150,350)); await sleep(randInt(2000,4000)); await humanMove(page, randInt(200,800), randInt(200,500)); }
      log('success', `  ✓ FB visit done — ${fbScrolls} scrolls ${elapsed(sessionStart)}`);
    } catch (e) { log('warning', `  FB visit error: ${e.message}`); }

    if (Math.random() < 0.6) { log('info', '  + Bing session'); await browseWebsite(page, 'https://www.bing.com', randInt(15000,25000), log, sessionStart); }
    if (!isDay1 || profile.sessionsCompleted > 1) {
      log('info', '  + Day 2+ extra FB idle');
      try { await page.goto(FB, { waitUntil:'domcontentloaded', timeout:20000 }); await sleep(randInt(5000,10000)); log('info', `  Done ${elapsed(sessionStart)}`); }
      catch (e) { log('warning', `  Extra FB idle failed: ${e.message}`); }
    }

    // ── STEP 7: Save + evaluate readiness ────────────────────────────────
    log('info', `[STEP 7/7] Saving session & evaluating readiness... ${elapsed(sessionStart)}`);
    await setStatus(profile, 'Step 7/7: Saving...');
    const sessionData = await saveSession(context);
    const cookieCount = JSON.parse(sessionData)?.cookies?.length || 0;
    profile.sessionData = sessionData;
    log('info', `  Saved ${cookieCount} cookies to MongoDB`);

    profile.sessionsCompleted++;
    profile.lastSessionAt = new Date();
    profile.daysWarmed    = Math.max(profile.daysWarmed, Math.floor((Date.now()-profile.createdAt.getTime())/86400000));
    if (profile.fbpCookieSetAt) {
      profile.fbpCookieAge = Math.round(((Date.now()-profile.fbpCookieSetAt.getTime())/86400000)*10)/10;
    }

    const hasSessions = profile.sessionsCompleted >= 4;
    const hasDays     = profile.daysWarmed        >= 2;
    const hasFbp      = !!profile.fbpCookieSetAt;
    const hasFbpAge   = profile.fbpCookieAge      >= 2;

    log('info', '  Readiness check:');
    log('info', `    Sessions : ${profile.sessionsCompleted}/4   ${hasSessions?'✓':'✗'}`);
    log('info', `    Days     : ${profile.daysWarmed}/2     ${hasDays?'✓':'✗'}`);
    log('info', `    _fbp set : ${hasFbp?'yes':'NO'}         ${hasFbp?'✓':'✗'}`);
    log('info', `    _fbp age : ${profile.fbpCookieAge}/2.0d  ${hasFbpAge?'✓':'✗'}`);

    if (hasSessions && hasDays && hasFbp && hasFbpAge && profile.status !== 'ready') {
      profile.status = 'ready';
      profile.statusDetail = `✅ Ready — ${profile.daysWarmed}d | ${profile.sessionsCompleted} sessions | _fbp: ${profile.fbpCookieAge}d`;
      profile.readyAt = new Date();
      log('success', '🟢 PROFILE READY — available for account creation!');
      emit('profile_ready', { profileId: profileId.toString() });
    } else {
      profile.status = 'warming';
      profile.statusDetail = `Day ${profile.daysWarmed} | ${profile.sessionsCompleted} sessions | _fbp: ${profile.fbpCookieAge||0}d`;
      const missing = [!hasSessions&&`${4-profile.sessionsCompleted} sessions`, !hasDays&&`${2-profile.daysWarmed} days`, !hasFbp&&'_fbp cookie', !hasFbpAge&&`_fbp age ${(2-profile.fbpCookieAge).toFixed(1)}d`].filter(Boolean);
      log('info', `  Still needs: ${missing.join(' | ')}`);
    }

    await profile.save();
    const total = Math.round((Date.now()-sessionStart)/1000);
    log('success', '══════════════════════════════════════════════');
    log('success', `SESSION COMPLETE ✓ — ${total}s | Sessions: ${profile.sessionsCompleted} | Days: ${profile.daysWarmed} | _fbp: ${profile.fbpCookieAge}d`);
    log('success', '══════════════════════════════════════════════');

  } catch (e) {
    const total = Math.round((Date.now()-sessionStart)/1000);
    log('error', `SESSION FAILED after ${total}s — ${e.message}`);
    if (e.stack) log('error', e.stack.split('\n').slice(0,3).join(' | '));
    profile.status = 'error'; profile.statusDetail = e.message.substring(0,120); profile.lastError = e.message;
    await profile.save();
  } finally {
    if (stopCast)     await stopCast().catch(() => {});
    if (stopMonitor)  stopMonitor();
    if (context)      await context.close().catch(() => {});
    if (proxyCleanup) await proxyCleanup().catch(() => {});
    _activeSessions.delete(profileId.toString());
    emitProfile(profile);
    emit('session_ended', { profileId: profileId.toString() });
    console.log(`[Farm] Session ended: ${profile.name}`);
  }
};

// ── CRUD ──────────────────────────────────────────────────────────────────────
const createProfile = async ({ name, proxyMode, proxy }) => {
  console.log(`[Farm] Creating: "${name}" | mode: ${proxyMode}`);
  const profile = new BrowserProfile({ name: name||`Farm-${Date.now()}`, proxyMode: proxyMode||'manual', proxy: proxy||{}, status:'new', statusDetail:'Created — waiting for first session' });
  await profile.save(); emitProfile(profile); return profile;
};
const getReadyProfile = async () => BrowserProfile.findOne({ status:'ready', fbpCookieAge:{$gte:2}, daysWarmed:{$gte:2} }).sort({ fbpCookieAge:-1 });
const markUsed        = async (id) => BrowserProfile.findByIdAndUpdate(id, { status:'used', usedAt:new Date(), statusDetail:'Consumed by account creator' });
const listProfiles    = async () => (await BrowserProfile.find({}).sort({ createdAt:-1 }).lean()).map(p=>({ ...p, isLive:_activeSessions.has(p._id.toString()) }));
const deleteProfile   = async (id) => {
  const s = _activeSessions.get(id.toString());
  if (s) { s.stopCast?.().catch(()=>{}); s.stopMonitor?.(); await s.context?.close().catch(()=>{}); _activeSessions.delete(id.toString()); }
  await BrowserProfile.findByIdAndDelete(id); emit('profile_deleted', { profileId: id.toString() });
};
const pauseProfile  = async (id) => { await BrowserProfile.findByIdAndUpdate(id, { status:'paused', statusDetail:'Paused by user' }); const p=await BrowserProfile.findById(id); if(p) emitProfile(p); };
const resumeProfile = async (id) => { await BrowserProfile.findByIdAndUpdate(id, { status:'warming', statusDetail:'Resumed — waiting for schedule' }); };
const getActiveSessions = () => _activeSessions.size;

// ── Scheduler ─────────────────────────────────────────────────────────────────
const startScheduler = () => {
  const cron = require('node-cron');
  const runDue = async () => {
    console.log(`[Farm] Scheduler tick — ${ts()}`);
    const profiles = await BrowserProfile.find({ status:{ $in:['new','warming'] } });
    console.log(`[Farm] ${profiles.length} profile(s) eligible`);
    for (const p of profiles) {
      if (_activeSessions.has(p._id.toString())) { console.log(`[Farm] ${p.name} — running, skip`); continue; }
      if (p.lastSessionAt && (Date.now()-p.lastSessionAt.getTime()) < 3*60*60*1000) { console.log(`[Farm] ${p.name} — too recent, skip`); continue; }
      console.log(`[Farm] Starting: ${p.name}`);
      runWarmSession(p._id.toString()).catch(e => console.error(`[Farm] Error ${p.name}:`, e.message));
      await sleep(30000);
    }
  };
  cron.schedule('0 9 * * *',  () => { console.log('[Farm] 9am tick');  runDue(); });
  cron.schedule('0 13 * * *', () => { console.log('[Farm] 1pm tick');  runDue(); });
  cron.schedule('0 19 * * *', () => { console.log('[Farm] 7pm tick');  runDue(); });
  setTimeout(() => { console.log('[Farm] Startup check...'); runDue(); }, 5000);
  console.log('[Farm] Scheduler active — 9am / 1pm / 7pm');
};

module.exports = { createProfile, getReadyProfile, markUsed, listProfiles, deleteProfile, pauseProfile, resumeProfile, runWarmSession, startScheduler, getActiveSessions, setIo };
