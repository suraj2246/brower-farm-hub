const BrowserProfile = require('../models/BrowserProfile');
const farmBrowser    = require('./farmBrowser');
const proxyMonitor   = require('./proxyMonitor');
const axios          = require('axios');

const {
  launchFarmBrowser, saveSession, startScreencast, humanMove,
  sleep, randInt, createInputBridge,
  clearCookies, clearStorage, deleteProfileDir,
} = farmBrowser;

const FB = 'https://www.facebook.com';

// profileId → { type, context, page, stopCast, stopMonitor, inputBridge, proxyCleanup, stopAll? }
const _activeSessions = new Map();

let _io = null;
const setIo = (io) => { _io = io; };
const emit  = (event, data) => { if (_io) _io.emit(event, data); };

const ts      = () => new Date().toISOString().replace('T',' ').substring(0,19);
const elapsed = (start) => `+${((Date.now()-start)/1000).toFixed(1)}s`;

const logProfile = (profile, level, msg) => {
  const line = `[${ts()}] ${msg}`;
  console.log(`[Farm:${profile.name}] [${level.toUpperCase()}] ${msg}`);
  profile.addLog(level, line);
  emit('farm_log', { profileId: profile._id.toString(), level, msg: line, time: new Date() });
};

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
    proxyPort:         profile.proxy?.port || 0,
    proxyProtocol:     profile.proxy?.protocol || '',
    interactive:       !!(profile.interactive?.active),
    autoDeleteDays:    profile.autoDeleteDays || 0,
    isLive:            _activeSessions.has(profile._id.toString()),
    shareCount:        (profile.shareLinks || []).length,
    viewportWidth:     profile.fingerprint?.viewport?.width || 0,
    viewportHeight:    profile.fingerprint?.viewport?.height || 0,
  });
};

const setStatus = async (profile, detail) => {
  profile.statusDetail = detail;
  await profile.save();
  emitProfile(profile);
};

// Atomic update from kill-switch — never collides with main session's save()
const killSessionUpdate = async (profileId, reason) => {
  try {
    await BrowserProfile.findByIdAndUpdate(profileId, {
      status: 'error',
      statusDetail: `Proxy killed: ${reason}`.substring(0, 200),
      lastError: reason,
      $inc: { proxyKillCount: 1 },
    });
  } catch {}
};

const fetchEngineProxy = async (log) => {
  const url = (process.env.ENGINE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.ENGINE_API_KEY || '').trim();
  log('info', `fetchEngineProxy() — ENGINE_URL: "${url || '(not set)'}"`);

  if (!url) throw new Error('ENGINE_URL env var not set — add it in Railway → Variables');
  if (!key) throw new Error('ENGINE_API_KEY env var not set — add it in Railway → Variables');
  try { new URL(url); } catch { throw new Error(`ENGINE_URL is invalid: "${url}"`); }

  const endpoint = `${url}/api/proxies?status=active&limit=50`;
  log('info', `Calling engine: GET ${endpoint}`);
  const res = await axios.get(endpoint, { headers: { 'x-engine-key': key }, timeout: 10000 });
  log('info', `Engine response: ${res.status}`);

  const all = (Array.isArray(res.data) ? res.data : (res.data?.proxies || [])).slice(0, 100);
  const proxies = all.filter(p => p.status === 'active');
  if (proxies.length === 0) {
    const summary = all.map(p => `${p.host}:${p.port}=${p.status}`).join(', ');
    throw new Error(`No active proxies in engine. Found: ${summary || 'none'}`);
  }

  // Random pick so parallel sessions don't grab the same proxy
  const p = proxies[Math.floor(Math.random() * proxies.length)];
  log('success', `Got proxy: ${p.protocol}://${p.host}:${p.port}`);
  return {
    protocol: p.protocol || 'socks5',
    host:     p.host,
    port:     p.port,
    username: p.username || '',
    password: p.password || '',
    engineProxyId: p._id,
  };
};

const browseWebsite = async (page, url, durationMs, log, sessionStart) => {
  const siteStart = Date.now();
  log('info', `→ ${url} (budget: ${Math.round(durationMs/1000)}s) ${elapsed(sessionStart)}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const title = await page.title().catch(() => '?');
    log('info', `  Loaded in ${Date.now()-siteStart}ms — "${title.substring(0, 50)}"`);
    await sleep(randInt(2000, 4000));

    const end = Date.now() + durationMs;
    let scrolls = 0, moves = 0;
    while (Date.now() < end) {
      try {
        await page.mouse.wheel(0, randInt(200, 500)); scrolls++;
        await sleep(randInt(1500, 3500));
        if (Math.random() < 0.4) { await humanMove(page, randInt(200,900), randInt(200,600)); await sleep(randInt(500,1200)); moves++; }
        if (Math.random() < 0.25) { await page.mouse.wheel(0, -randInt(100,250)); await sleep(randInt(800,1500)); }
      } catch { break; } // page closed mid-browse
    }
    log('success', `  ✓ ${url} — ${Math.round((Date.now()-siteStart)/1000)}s | ${scrolls} scrolls | ${moves} moves`);
    return true;
  } catch (e) {
    log('warning', `  ✗ ${url}: ${e.message}`);
    return false;
  }
};

const runWarmSession = async (profileId) => {
  const sessionStart = Date.now();
  const profile = await BrowserProfile.findById(profileId);
  if (!profile) { console.log(`[Farm] Profile ${profileId} not found`); return; }
  if (_activeSessions.has(profileId.toString())) { console.log(`[Farm] ${profile.name} already running`); return; }
  if (profile.interactive?.active)              { console.log(`[Farm] ${profile.name} in interactive mode, skip warm`); return; }
  if (profile.status === 'paused')              { console.log(`[Farm] ${profile.name} paused, skip`); return; }

  const log = (level, msg) => logProfile(profile, level, msg);

  log('info', '══════════════════════════════════════════════');
  log('info', `SESSION START — "${profile.name}"`);
  log('info', `Session #${profile.sessionsCompleted + 1} | Days: ${profile.warmDates?.length || 0} | Mode: ${profile.proxyMode.toUpperCase()}`);
  log('info', '══════════════════════════════════════════════');

  // STEP 1 — proxy resolution
  log('info', `[STEP 1/7] Resolving proxy... ${elapsed(sessionStart)}`);
  let proxyData;
  try {
    if (profile.proxyMode === 'engine') {
      log('info', '  Mode=ENGINE → fetching from SocialHub Engine');
      proxyData = await fetchEngineProxy(log);
      profile.proxy = proxyData;
      await profile.save();
    } else {
      proxyData = profile.proxy;
      log('info', `  Mode=MANUAL → ${proxyData?.host}:${proxyData?.port}`);
    }
    if (!proxyData?.host || !proxyData?.port) throw new Error('Proxy host/port missing');
    log('success', `  ✓ Proxy: ${proxyData.protocol}://${proxyData.host}:${proxyData.port} auth:${!!proxyData.username} ${elapsed(sessionStart)}`);
  } catch (e) {
    log('error', `  ✗ STEP 1: ${e.message}`);
    profile.status = 'error'; profile.statusDetail = e.message.substring(0,200); profile.lastError = e.message;
    await profile.save().catch(()=>{}); emitProfile(profile); return;
  }

  // STEP 2 — verify proxy
  log('info', `[STEP 2/7] Pinging proxy... ${elapsed(sessionStart)}`);
  await setStatus(profile, 'Step 2/7: Verifying proxy...');
  const check = await proxyMonitor.verifyProxy(proxyData);
  if (!check.ok) {
    log('error', `  ✗ STEP 2: ${check.error} — ABORTING (no bare-IP launch)`);
    profile.status = 'error'; profile.statusDetail = `Proxy dead: ${check.error}`.substring(0,200); profile.lastError = check.error;
    await profile.save().catch(()=>{}); emitProfile(profile); return;
  }
  log('success', `  ✓ Proxy alive — IP: ${check.ip} ${elapsed(sessionStart)}`);

  // STEP 3 — launch
  log('info', `[STEP 3/7] Launching browser... ${elapsed(sessionStart)}`);
  await setStatus(profile, 'Step 3/7: Launching browser...');
  profile.status = 'warming'; await profile.save(); emitProfile(profile);

  let context, page, fp, proxyCleanup, stopCast, stopMonitor;
  let sessionKilled = false;
  try {
    const launched = await launchFarmBrowser(profile);
    context = launched.context; page = launched.page; fp = launched.fp; proxyCleanup = launched.cleanup;
    if (!profile.fingerprint?.userAgent) {
      profile.fingerprint = fp;
      await profile.save();
      log('info', `  Fingerprint locked: Chrome ${fp.chromeVersion} | ${fp.platform} | ${fp.viewport.width}x${fp.viewport.height} | ${fp.gpuClass} GPU | ${fp.timezone}`);
    } else {
      log('info', `  Reusing fingerprint: Chrome ${fp.chromeVersion}`);
    }
    log('success', `  ✓ Browser launched ${elapsed(sessionStart)}`);

    // STEP 4 — kill switch + screencast
    log('info', `[STEP 4/7] Kill switch & screencast... ${elapsed(sessionStart)}`);
    stopMonitor = proxyMonitor.startMonitor(proxyData, async (reason) => {
      log('error', `  ⚡ KILL SWITCH: ${reason}`);
      sessionKilled = true;
      await killSessionUpdate(profileId, reason);
      await context.close().catch(()=>{});
      _activeSessions.delete(profileId.toString());
      emit('session_killed', { profileId: profileId.toString(), reason });
    }, log);

    const screencast = await startScreencast(page, (frame) =>
      emit('farm_frame', {
        profileId: profileId.toString(), frame,
        viewportWidth: fp.viewport.width, viewportHeight: fp.viewport.height,
      })
    );
    stopCast = screencast.stop;
    _activeSessions.set(profileId.toString(), { type:'warm', context, page, stopCast, stopMonitor, proxyCleanup });
    emit('session_started', { profileId: profileId.toString() });

    const isDay1 = (profile.warmDates?.length || 0) === 0;

    // STEP 5 — neutral browsing
    if (sessionKilled) return;
    log('info', `[STEP 5/7] Browsing neutral sites... ${elapsed(sessionStart)}`);
    await setStatus(profile, 'Step 5/7: Browsing news...');
    const news = ['https://www.bbc.com','https://www.reuters.com','https://www.theguardian.com','https://www.cnn.com','https://www.npr.org'];
    const picks = news.sort(() => Math.random()-0.5).slice(0, randInt(2,3));
    log('info', `  Picked: ${picks.join(', ')}`);
    for (const site of picks) {
      if (sessionKilled) break;
      await browseWebsite(page, site, randInt(25000,40000), log, sessionStart);
      await sleep(randInt(3000,6000));
    }
    if (!sessionKilled && Math.random() < 0.7) {
      log('info', '  + YouTube');
      await browseWebsite(page, 'https://www.youtube.com', randInt(25000,40000), log, sessionStart);
    }

    // STEP 6 — Facebook guest visit (sets _fbp cookie)
    if (sessionKilled) return;
    log('info', `[STEP 6/7] Facebook visit... ${elapsed(sessionStart)}`);
    await setStatus(profile, 'Step 6/7: Facebook visit...');
    try {
      await page.goto(FB, { waitUntil:'domcontentloaded', timeout:25000 });
      log('info', `  FB loaded — "${(await page.title().catch(()=>'?')).substring(0,50)}"`);
      await sleep(randInt(3000,5000));

      const cookies = await context.cookies(['https://www.facebook.com']);
      const fbp = cookies.find(c => c.name === '_fbp');
      if (fbp) {
        if (!profile.fbpCookieSetAt) {
          profile.fbpCookieSetAt = new Date();
          log('success', `  ✓ _fbp set — aging clock started`);
        } else {
          profile.fbpCookieAge = Math.round(((Date.now()-profile.fbpCookieSetAt.getTime())/86400000)*10)/10;
          log('success', `  ✓ _fbp age: ${profile.fbpCookieAge} / 2.0d`);
        }
      } else {
        log('warning', '  ✗ _fbp not set');
      }

      const scrolls = randInt(3,6);
      for (let i=0; i<scrolls; i++) {
        if (sessionKilled) break;
        await page.mouse.wheel(0, randInt(150,350)).catch(()=>{});
        await sleep(randInt(2000,4000));
        await humanMove(page, randInt(200,800), randInt(200,500));
      }
      log('success', `  ✓ FB done — ${scrolls} scrolls ${elapsed(sessionStart)}`);
    } catch (e) {
      log('warning', `  FB visit error: ${e.message}`);
    }

    if (!sessionKilled && Math.random() < 0.6) {
      log('info', '  + Bing');
      await browseWebsite(page, 'https://www.bing.com', randInt(15000,25000), log, sessionStart);
    }
    if (!sessionKilled && (!isDay1 || profile.sessionsCompleted > 1)) {
      log('info', '  + Extra FB idle');
      try {
        await page.goto(FB, { waitUntil:'domcontentloaded', timeout:20000 });
        await sleep(randInt(5000,10000));
      } catch (e) { log('warning', `  Extra FB idle: ${e.message}`); }
    }

    // STEP 7 — save
    if (sessionKilled) return;
    log('info', `[STEP 7/7] Saving... ${elapsed(sessionStart)}`);
    await setStatus(profile, 'Step 7/7: Saving...');
    const sessionData = await saveSession(context).catch(e => { throw new Error('saveSession: ' + e.message); });
    const cookieCount = JSON.parse(sessionData)?.cookies?.length || 0;
    profile.sessionData = sessionData;
    log('info', `  ${cookieCount} cookies saved to MongoDB backup`);

    profile.sessionsCompleted++;
    profile.lastSessionAt = new Date();
    profile.recordSessionDay();
    profile.daysWarmed = profile.warmDates?.length || 0;
    if (profile.fbpCookieSetAt) {
      profile.fbpCookieAge = Math.round(((Date.now()-profile.fbpCookieSetAt.getTime())/86400000)*10)/10;
    }

    const hasSessions = profile.sessionsCompleted >= 4;
    const hasDays     = (profile.warmDates?.length || 0) >= 2;
    const hasFbp      = !!profile.fbpCookieSetAt;
    const hasFbpAge   = profile.fbpCookieAge >= 2;

    log('info', `  Readiness: sess ${profile.sessionsCompleted}/4 ${hasSessions?'✓':'✗'} | days ${profile.warmDates?.length||0}/2 ${hasDays?'✓':'✗'} | _fbp ${hasFbp?'set':'-'} ${hasFbp?'✓':'✗'} | age ${profile.fbpCookieAge}/2.0 ${hasFbpAge?'✓':'✗'}`);

    if (hasSessions && hasDays && hasFbp && hasFbpAge && profile.status !== 'ready') {
      profile.status = 'ready';
      profile.statusDetail = `Ready — ${profile.warmDates.length}d | ${profile.sessionsCompleted} sessions | _fbp ${profile.fbpCookieAge}d`;
      profile.readyAt = new Date();
      log('success', '🟢 PROFILE READY');
      emit('profile_ready', { profileId: profileId.toString() });
    } else {
      profile.status = 'warming';
      profile.statusDetail = `Day ${profile.warmDates.length} | ${profile.sessionsCompleted} sessions | _fbp ${profile.fbpCookieAge||0}d`;
    }

    await profile.save();
    const total = Math.round((Date.now()-sessionStart)/1000);
    log('success', `SESSION COMPLETE — ${total}s`);

  } catch (e) {
    log('error', `SESSION FAILED — ${e.message}`);
    if (!sessionKilled) {
      profile.status = 'error';
      profile.statusDetail = e.message.substring(0,120);
      profile.lastError = e.message;
      await profile.save().catch(()=>{});
    }
  } finally {
    if (stopCast)     await stopCast().catch(()=>{});
    if (stopMonitor)  stopMonitor();
    if (context)      await context.close().catch(()=>{});
    if (proxyCleanup) await proxyCleanup().catch(()=>{});
    _activeSessions.delete(profileId.toString());
    emitProfile(profile);
    emit('session_ended', { profileId: profileId.toString() });
  }
};

// — Interactive: launches a browser, keeps it open, exposes input bridge —
const launchInteractive = async (profileId) => {
  const profile = await BrowserProfile.findById(profileId);
  if (!profile)                                  throw new Error('Profile not found');
  if (_activeSessions.has(profileId.toString())) throw new Error('Profile already has an active session (warm or interactive). Wait for it to finish or pause it.');

  const log = (level, msg) => logProfile(profile, level, msg);
  log('info', '── INTERACTIVE SESSION STARTING ──');

  // Resolve proxy AFTER checking mode (engine mode populates proxy on-demand)
  let proxyData;
  if (profile.proxyMode === 'engine') {
    proxyData = await fetchEngineProxy(log); // throws if ENGINE_URL not set / no active proxies
    profile.proxy = proxyData;
    await profile.save();
  } else {
    proxyData = profile.proxy;
    if (!proxyData?.host || !proxyData?.port) {
      throw new Error('No proxy configured — click "🌐 Edit proxy" on the profile card and set one first');
    }
  }

  const v = await proxyMonitor.verifyProxy(proxyData);
  if (!v.ok) throw new Error(`Proxy unreachable: ${v.error} (host: ${proxyData.host}:${proxyData.port}, protocol: ${proxyData.protocol})`);
  log('success', `  Proxy alive — IP: ${v.ip}`);

  const launched = await launchFarmBrowser(profile, { blockResources: false });
  const { context, page, fp, cleanup: proxyCleanup } = launched;

  if (!profile.fingerprint?.userAgent) profile.fingerprint = fp;
  profile.interactive = { active: true, startedAt: new Date() };
  profile.status = 'interactive';
  profile.statusDetail = 'Interactive — user-controlled';
  await profile.save();

  // Kill switch (tolerates IP rotation — residential proxies often rotate during legit sessions)
  const stopMonitor = proxyMonitor.startMonitor(proxyData, async (reason) => {
    log('error', `  ⚡ INTERACTIVE KILL: ${reason}`);
    await killSessionUpdate(profileId, reason);
    await context.close().catch(()=>{});
    _activeSessions.delete(profileId.toString());
    emit('session_killed', { profileId: profileId.toString(), reason });
  }, log, { tolerateIpRotation: true });

  const screencast = await startScreencast(page, (frame, metadata) => {
    emit('farm_frame', {
      profileId:      profileId.toString(),
      frame,
      viewportWidth:  fp.viewport.width,
      viewportHeight: fp.viewport.height,
      metadata,
    });
  }, { quality: 75, maxWidth: fp.viewport.width, maxHeight: fp.viewport.height, everyNthFrame: 1 });

  const inputBridge = createInputBridge(screencast.cdp);

  let stopping = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    log('info', 'Stopping interactive session...');
    try { await screencast.stop(); } catch {}
    try { stopMonitor(); } catch {}
    try { await saveAndMarkClosed(profile, context); } catch (e) { log('warning', `Save err: ${e.message}`); }
    try { await proxyCleanup(); } catch {}
    _activeSessions.delete(profileId.toString());
    emit('session_ended', { profileId: profileId.toString() });
  };

  page.on('close',    () => { log('info', 'Page closed — ending interactive'); stopAll().catch(()=>{}); });
  context.on('close', () => { log('info', 'Context closed');                   stopAll().catch(()=>{}); });

  _activeSessions.set(profileId.toString(), {
    type: 'interactive', context, page,
    stopCast: screencast.stop, stopMonitor, inputBridge, proxyCleanup, stopAll,
  });

  // Default landing — about:blank by default; user navigates from the URL bar
  page.goto('about:blank').catch(()=>{});

  emit('session_started', { profileId: profileId.toString() });
  emitProfile(profile);
  log('success', '  Interactive session ready');
  return {
    ok: true,
    viewportWidth:  fp.viewport.width,
    viewportHeight: fp.viewport.height,
  };
};

const saveAndMarkClosed = async (profile, context) => {
  try { profile.sessionData = JSON.stringify(await context.storageState()); } catch {}
  profile.interactive = { active: false, startedAt: null };
  if (profile.status === 'interactive') profile.status = 'warming';
  profile.statusDetail = 'Interactive session ended';
  await profile.save().catch(()=>{});
  await context.close().catch(()=>{});
  emitProfile(profile);
};

const stopInteractive = async (profileId) => {
  const s = _activeSessions.get(profileId.toString());
  if (!s) {
    const profile = await BrowserProfile.findById(profileId);
    if (profile) {
      profile.interactive = { active: false, startedAt: null };
      if (profile.status === 'interactive') profile.status = 'warming';
      await profile.save();
      emitProfile(profile);
    }
    return { ok: true, note: 'No active session' };
  }
  if (s.type !== 'interactive') throw new Error('Active session is not interactive — stop warm sessions via pause');
  if (s.stopAll) await s.stopAll();
  return { ok: true };
};

const dispatchInput = async (profileId, input) => {
  const s = _activeSessions.get(profileId.toString());
  if (!s || s.type !== 'interactive') throw new Error('No interactive session');
  if (!s.inputBridge) throw new Error('Input bridge not ready');

  switch (input.action) {
    case 'mouseDown':
    case 'mouseUp':
    case 'mouseMove':
      await s.inputBridge.dispatchMouse({
        type: input.action === 'mouseDown' ? 'mousePressed'
            : input.action === 'mouseUp'   ? 'mouseReleased' : 'mouseMoved',
        x: Math.round(input.x), y: Math.round(input.y),
        button: input.button || 'left',
        clickCount: input.clickCount || 1,
        modifiers: input.modifiers || 0,
      });
      break;
    case 'wheel':
      await s.inputBridge.dispatchWheel(Math.round(input.x||0), Math.round(input.y||0), Math.round(input.deltaX||0), Math.round(input.deltaY||0));
      break;
    case 'keyDown':
    case 'keyUp':
    case 'char':
      await s.inputBridge.dispatchKey({
        type: input.action === 'char' ? 'char' : (input.action === 'keyDown' ? 'keyDown' : 'keyUp'),
        text: input.text || undefined,
        key:  input.key  || undefined,
        code: input.code || undefined,
        modifiers: input.modifiers || 0,
        windowsVirtualKeyCode: input.keyCode || undefined,
        nativeVirtualKeyCode:  input.keyCode || undefined,
      });
      break;
    case 'navigate':
      if (input.url && /^https?:\/\//i.test(input.url)) {
        await s.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      }
      break;
    case 'back':    await s.page.goBack().catch(()=>{});    break;
    case 'forward': await s.page.goForward().catch(()=>{}); break;
    case 'reload':  await s.page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{}); break;
    case 'currentUrl': return { url: s.page.url() };
    default: throw new Error(`Unknown input action: ${input.action}`);
  }
};

// — CRUD —
const createProfile = async ({ name, proxyMode, proxy, autoDeleteDays }) => {
  const profile = new BrowserProfile({
    name: name || `Farm-${Date.now()}`,
    proxyMode: proxyMode || 'manual',
    proxy: proxy || {},
    autoDeleteDays: Number(autoDeleteDays) || 0,
    status: 'new',
    statusDetail: 'Created — waiting for first session',
  });
  await profile.save();
  emitProfile(profile);
  return profile;
};

// Edit proxy anytime (your requested feature)
const updateProxy = async (id, { proxyMode, proxy }) => {
  const profile = await BrowserProfile.findById(id);
  if (!profile) throw new Error('Profile not found');
  if (_activeSessions.has(id.toString())) throw new Error('Cannot edit proxy while session is active — stop the session first');

  if (proxyMode === 'manual') {
    if (!proxy?.host || !proxy?.port) throw new Error('Manual mode requires host and port');
    profile.proxyMode = 'manual';
    profile.proxy = {
      protocol: proxy.protocol || 'socks5',
      host:     proxy.host,
      port:     Number(proxy.port),
      username: proxy.username || '',
      password: proxy.password || '',
      engineProxyId: null,
    };
  } else if (proxyMode === 'engine') {
    profile.proxyMode = 'engine';
    profile.proxy = { protocol:'socks5', host:'', port:0, username:'', password:'', engineProxyId:null };
  } else {
    throw new Error(`Invalid proxyMode: ${proxyMode}`);
  }
  profile.addLog('info', `Proxy updated → mode=${proxyMode}, host=${profile.proxy.host || '(engine)'}`);
  await profile.save();
  emitProfile(profile);
  return profile;
};

// Atomic claim (fixes the /ready race)
const getReadyProfile = async () => {
  const profile = await BrowserProfile.findOneAndUpdate(
    {
      status: 'ready',
      fbpCookieAge: { $gte: 2 },
      daysWarmed:   { $gte: 2 },
      'interactive.active': { $ne: true },
    },
    { status: 'reserved', reservedAt: new Date() },
    { sort: { fbpCookieAge: -1 }, new: true }
  );
  if (profile) emitProfile(profile);
  return profile;
};

const markUsed = async (id) => {
  const p = await BrowserProfile.findByIdAndUpdate(id, {
    status: 'used',
    usedAt: new Date(),
    reservedAt: null,
    statusDetail: 'Consumed',
  }, { new: true });
  if (p) emitProfile(p);
  return p;
};

const releaseReservation = async (id) => {
  const p = await BrowserProfile.findOne({ _id: id, status: 'reserved' });
  if (!p) return null;
  p.status = 'ready';
  p.reservedAt = null;
  p.statusDetail = 'Reservation released';
  await p.save();
  emitProfile(p);
  return p;
};

const listProfiles = async () => {
  const list = await BrowserProfile.find({}).sort({ createdAt: -1 }).lean();
  return list.map(p => ({
    ...p,
    isLive: _activeSessions.has(p._id.toString()),
    sessionData: undefined,                // strip — large
    logs:        undefined,                // strip — fetched via /logs endpoint
    shareLinks: (p.shareLinks || []).map(s => ({
      _id: s._id, token: s.token, label: s.label,
      expiresAt: s.expiresAt, createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt, useCount: s.useCount,
      // passwordHash deliberately omitted
    })),
  }));
};

const deleteProfile = async (id) => {
  const s = _activeSessions.get(id.toString());
  if (s) {
    if (s.stopAll) await s.stopAll().catch(()=>{});
    else {
      s.stopCast?.().catch(()=>{});
      s.stopMonitor?.();
      await s.context?.close().catch(()=>{});
      _activeSessions.delete(id.toString());
    }
  }
  try { deleteProfileDir(id.toString()); } catch {}
  await BrowserProfile.findByIdAndDelete(id);
  emit('profile_deleted', { profileId: id.toString() });
};

const pauseProfile = async (id) => {
  const s = _activeSessions.get(id.toString());
  if (s) {
    if (s.type === 'interactive') throw new Error('Stop interactive session first');
    s.stopCast?.().catch(()=>{});
    s.stopMonitor?.();
    await s.context?.close().catch(()=>{});
    _activeSessions.delete(id.toString());
  }
  const p = await BrowserProfile.findByIdAndUpdate(id, { status:'paused', statusDetail:'Paused by user' }, { new: true });
  if (p) emitProfile(p);
};

const resumeProfile = async (id) => {
  const p = await BrowserProfile.findByIdAndUpdate(id, { status:'warming', statusDetail:'Resumed — waiting' }, { new: true });
  if (p) emitProfile(p);
};

// CLEAR operations (cookies / storage / browser / sessions)
const clearProfile = async (id, what) => {
  const profile = await BrowserProfile.findById(id);
  if (!profile) throw new Error('Profile not found');
  const active = _activeSessions.get(id.toString());

  if (what === 'cookies') {
    if (active) await clearCookies(active.context);
    profile.sessionData = null;
    profile.fbpCookieSetAt = null;
    profile.fbpCookieAge = 0;
    profile.addLog('warning', 'Cookies cleared');
  } else if (what === 'storage') {
    if (active) await clearStorage(active.page);
    profile.addLog('warning', 'LocalStorage / sessionStorage / IndexedDB cleared');
  } else if (what === 'browser') {
    // Wipe everything: close session, delete persistent profile dir, reset counters
    if (active) {
      if (active.stopAll) await active.stopAll().catch(()=>{});
      else {
        active.stopCast?.().catch(()=>{});
        active.stopMonitor?.();
        await active.context?.close().catch(()=>{});
        _activeSessions.delete(id.toString());
      }
    }
    deleteProfileDir(id.toString());
    profile.sessionData = null;
    profile.fbpCookieSetAt = null;
    profile.fbpCookieAge = 0;
    profile.sessionsCompleted = 0;
    profile.warmDates = [];
    profile.daysWarmed = 0;
    profile.status = 'new';
    profile.statusDetail = 'Browser wiped — fresh start';
    profile.addLog('warning', 'Browser data fully wiped (dir + cookies + counters)');
  } else if (what === 'sessions') {
    profile.sessionsCompleted = 0;
    profile.warmDates = [];
    profile.daysWarmed = 0;
    profile.addLog('warning', 'Session counters reset');
  } else {
    throw new Error(`Unknown clear target: ${what}`);
  }
  await profile.save();
  emitProfile(profile);
  return profile;
};

// — Scheduler. No auto-delete (per your request). Reservation sweep still runs. —
const startScheduler = () => {
  const cron = require('node-cron');

  const runDue = async () => {
    console.log(`[Farm] Scheduler tick — ${ts()}`);
    const profiles = await BrowserProfile.find({
      status: { $in: ['new','warming'] },
      'interactive.active': { $ne: true },
    });
    console.log(`[Farm] ${profiles.length} eligible`);
    for (const p of profiles) {
      if (_activeSessions.has(p._id.toString())) continue;
      if (p.lastSessionAt && (Date.now() - p.lastSessionAt.getTime()) < 3 * 60 * 60 * 1000) continue;
      console.log(`[Farm] Starting: ${p.name}`);
      runWarmSession(p._id.toString()).catch(e => console.error(`[Farm] Err ${p.name}:`, e.message));
      await sleep(30000);
    }
  };

  // Release reservations stuck > 10 minutes
  const reservationSweep = async () => {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const stuck = await BrowserProfile.find({ status: 'reserved', reservedAt: { $lt: cutoff } });
    for (const p of stuck) {
      console.log(`[Farm] Releasing stuck reservation: ${p.name}`);
      await releaseReservation(p._id.toString()).catch(() => {});
    }
  };

  cron.schedule('0 9 * * *',   () => runDue());
  cron.schedule('0 13 * * *',  () => runDue());
  cron.schedule('0 19 * * *',  () => runDue());
  cron.schedule('*/10 * * * *',() => reservationSweep());
  setTimeout(() => { runDue(); reservationSweep(); }, 5000);
  console.log('[Farm] Scheduler active — 9am / 1pm / 7pm + reservation sweep every 10min');
};

const getActiveSessions = () => _activeSessions.size;
const getSessionInfo    = (id) => _activeSessions.get(id.toString());

module.exports = {
  createProfile, updateProxy,
  getReadyProfile, markUsed, releaseReservation,
  listProfiles, deleteProfile, pauseProfile, resumeProfile,
  runWarmSession, launchInteractive, stopInteractive, dispatchInput,
  clearProfile,
  startScheduler, getActiveSessions, getSessionInfo, setIo,
};
