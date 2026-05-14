const { chromium } = require('playwright');
const path = require('path');   // ← FIXED (was require('fs'))
const fs   = require('fs');

// — UA list (each UA paired with platform for consistency) —
const UAS = [
  { ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', platform:'Win32',    chromeVersion:'135' },
  { ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', platform:'Win32',    chromeVersion:'134' },
  { ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36', platform:'Win32',    chromeVersion:'133' },
  { ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', platform:'MacIntel', chromeVersion:'135' },
  { ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36', platform:'MacIntel', chromeVersion:'134' },
];

const VIEWPORTS = [
  { width:1366, height:768  },
  { width:1440, height:900  },
  { width:1536, height:864  },
  { width:1600, height:900  },
  { width:1920, height:1080 },
];

// — GPU classes: vendor + renderers are paired so they match (the bug we hit before) —
const GPU_CLASSES = [
  { cls:'nvidia', vendor:'Google Inc. (NVIDIA)', renderers:[
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]},
  { cls:'intel',  vendor:'Google Inc. (Intel)',  renderers:[
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]},
  { cls:'amd',    vendor:'Google Inc. (AMD)',    renderers:[
    'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]},
  { cls:'apple',  vendor:'Google Inc. (Apple)',  renderers:[
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
  ]},
];

const TIMEZONES_US = ['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'];

const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];

const buildFingerprint = (profile) => {
  if (profile.fingerprint && profile.fingerprint.userAgent) return profile.fingerprint;
  const uaPick = pick(UAS);
  const isMac  = uaPick.platform === 'MacIntel';
  const gpu = isMac
    ? GPU_CLASSES.find(g => g.cls === 'apple')
    : pick(GPU_CLASSES.filter(g => g.cls !== 'apple'));
  return {
    userAgent:     uaPick.ua,
    viewport:      pick(VIEWPORTS),
    timezone:      pick(TIMEZONES_US),
    locale:        'en-US',
    platform:      uaPick.platform,
    cpuCores:      pick([4,6,8,8,12,16]),
    deviceMem:     pick([4,8,8,8,16,16]),
    webglVendor:   gpu.vendor,
    webglRenderer: pick(gpu.renderers),
    canvasSeed:    Math.floor(Math.random() * 9999999),
    audioSeed:     Math.random(),
    chromeVersion: uaPick.chromeVersion,
    gpuClass:      gpu.cls,
  };
};

// Init script runs before page scripts. Removes the obvious headless tells and
// makes navigator props internally consistent across reads.
const buildStealthScript = (fp) => `(function(){
'use strict';

// — webdriver flag + automation hooks —
Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});
const dropKeys = Object.getOwnPropertyNames(window).filter(k =>
  k.startsWith('cdc_') || k.startsWith('__playwright') || k.startsWith('__pw_') ||
  k === '_playwright' || k === '__$webdriverAsyncExecutor'
);
dropKeys.forEach(k => { try { delete window[k]; } catch(e){} });

// — navigator core —
Object.defineProperty(navigator,'platform',{get:()=>'${fp.platform}'});
Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>${fp.cpuCores}});
Object.defineProperty(navigator,'deviceMemory',{get:()=>${fp.deviceMem}});
Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
Object.defineProperty(navigator,'doNotTrack',{get:()=>null});
Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0});
Object.defineProperty(navigator,'vendor',{get:()=>'Google Inc.'});
Object.defineProperty(navigator,'vendorSub',{get:()=>''});
Object.defineProperty(navigator,'productSub',{get:()=>'20030107'});

// — screen + window dims —
Object.defineProperty(screen,'width',{get:()=>${fp.viewport.width}});
Object.defineProperty(screen,'height',{get:()=>${fp.viewport.height}});
Object.defineProperty(screen,'availWidth',{get:()=>${fp.viewport.width}});
Object.defineProperty(screen,'availHeight',{get:()=>Math.round(${fp.viewport.height} * 0.94)});
Object.defineProperty(screen,'colorDepth',{get:()=>24});
Object.defineProperty(screen,'pixelDepth',{get:()=>24});
Object.defineProperty(window,'outerWidth',{get:()=>${fp.viewport.width}});
Object.defineProperty(window,'outerHeight',{get:()=>${fp.viewport.height}});
Object.defineProperty(window,'devicePixelRatio',{get:()=>1});

// — plugins: headless chrome has empty plugins, real chrome has 5 PDF plugins —
try {
  const pdfMime = Object.create(MimeType.prototype);
  Object.defineProperties(pdfMime, {
    type:        { value: 'application/pdf', enumerable: true },
    suffixes:    { value: 'pdf',             enumerable: true },
    description: { value: 'Portable Document Format', enumerable: true },
  });
  const mkPlug = (name, filename) => {
    const p = Object.create(Plugin.prototype);
    Object.defineProperties(p, {
      name:        { value: name,     enumerable: true },
      filename:    { value: filename, enumerable: true },
      description: { value: 'Portable Document Format', enumerable: true },
      length:      { value: 1,        enumerable: true },
      0:           { value: pdfMime,  enumerable: true },
    });
    Object.defineProperty(pdfMime, 'enabledPlugin', { value: p, configurable: true });
    return p;
  };
  const plugs = [
    mkPlug('PDF Viewer',              'internal-pdf-viewer'),
    mkPlug('Chrome PDF Viewer',       'internal-pdf-viewer'),
    mkPlug('Chromium PDF Viewer',     'internal-pdf-viewer'),
    mkPlug('Microsoft Edge PDF Viewer','internal-pdf-viewer'),
    mkPlug('WebKit built-in PDF',     'internal-pdf-viewer'),
  ];
  const pa = Object.create(PluginArray.prototype);
  plugs.forEach((p, i) => Object.defineProperty(pa, i, { value: p, enumerable: true }));
  Object.defineProperty(pa, 'length', { value: plugs.length });
  pa.item      = (i) => plugs[i] || null;
  pa.namedItem = (n) => plugs.find(p => p.name === n) || null;
  pa.refresh   = () => {};
  Object.defineProperty(navigator, 'plugins', { get: () => pa, configurable: true });

  const ma = Object.create(MimeTypeArray.prototype);
  Object.defineProperty(ma, 0, { value: pdfMime, enumerable: true });
  Object.defineProperty(ma, 'length', { value: 1 });
  ma.item      = (i) => i === 0 ? pdfMime : null;
  ma.namedItem = (n) => n === 'application/pdf' ? pdfMime : null;
  Object.defineProperty(navigator, 'mimeTypes', { get: () => ma, configurable: true });
} catch(e) {}

// — Canvas fingerprint noise (per-profile seed makes it consistent across reads) —
const _cs = ${fp.canvasSeed};
const noise = (data) => {
  for (let i = 0; i < data.length; i += 4) {
    data[i]   = data[i]   ^ ((_cs * (i + 1))  % 3);
    data[i+1] = data[i+1] ^ ((_cs * (i + 7))  % 3);
    data[i+2] = data[i+2] ^ ((_cs * (i + 13)) % 3);
  }
};
const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(type) {
  try {
    const ctx = this.getContext('2d');
    if (ctx) {
      const w = this.width || 1, h = this.height || 1;
      const id = ctx.getImageData(0, 0, w, h);
      noise(id.data);
      ctx.putImageData(id, 0, 0);
    }
  } catch(e) {}
  return _toDataURL.apply(this, arguments);
};
const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function() {
  const id = _getImageData.apply(this, arguments);
  noise(id.data);
  return id;
};

// — WebGL: vendor & renderer paired in fp, return them consistently —
const patchWebGL = (Ctx) => {
  if (!Ctx) return;
  const gp = Ctx.prototype.getParameter;
  Ctx.prototype.getParameter = function(p) {
    if (p === 37445) return '${fp.webglVendor}';
    if (p === 37446) return '${fp.webglRenderer}';
    return gp.apply(this, arguments);
  };
};
patchWebGL(window.WebGLRenderingContext);
try { patchWebGL(window.WebGL2RenderingContext); } catch(e) {}

// — chrome runtime object —
window.chrome = window.chrome || {
  app: { isInstalled: false },
  runtime: { id: undefined, connect: () => undefined, sendMessage: () => undefined },
  loadTimes: function() { return {}; },
  csi:       function() { return { onloadT: Date.now(), pageT: Date.now(), startE: Date.now(), tran: 15 }; },
};

// — permissions —
const _permQuery = navigator.permissions && navigator.permissions.query;
if (_permQuery) {
  navigator.permissions.query = (params) => {
    if (params && params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission, onchange: null });
    }
    return _permQuery.call(navigator.permissions, params);
  };
}

// — performance.memory (Chrome-only, expected on real Chrome) —
if (!performance.memory) {
  Object.defineProperty(performance, 'memory', {
    get: () => ({
      jsHeapSizeLimit: 2172649472,
      totalJSHeapSize: ${fp.cpuCores} * 40 * 1024 * 1024,
      usedJSHeapSize:  ${fp.cpuCores} * 25 * 1024 * 1024,
    })
  });
}

// — battery: stable values, real Chrome has it —
if (navigator.getBattery) {
  navigator.getBattery = () => Promise.resolve({
    charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
}

// — network connection —
if (navigator.connection) {
  try {
    Object.defineProperty(navigator.connection, 'rtt',           { get: () => 50,    configurable: true });
    Object.defineProperty(navigator.connection, 'downlink',      { get: () => 10,    configurable: true });
    Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g',  configurable: true });
    Object.defineProperty(navigator.connection, 'saveData',      { get: () => false, configurable: true });
  } catch(e) {}
}

// — Function.prototype.toString.toString() —
// Real Chrome returns native code for all of these patched functions. Without this,
// String(navigator.permissions.query) reveals the patched body.
const nativeToString = Function.prototype.toString;
const toStringMap = new WeakMap();
const tagAsNative = (fn) => { toStringMap.set(fn, true); return fn; };
Function.prototype.toString = function() {
  if (toStringMap.has(this)) return 'function ' + (this.name || '') + '() { [native code] }';
  return nativeToString.apply(this, arguments);
};
tagAsNative(navigator.permissions && navigator.permissions.query);
tagAsNative(navigator.getBattery);
tagAsNative(HTMLCanvasElement.prototype.toDataURL);
tagAsNative(CanvasRenderingContext2D.prototype.getImageData);
})();`;

// Profile directory (persistent context). Note: Railway containers are ephemeral —
// for survival across redeploys, attach a Railway Volume mounted at `.farm-profiles`.
const PROFILES_DIR = path.join(process.cwd(), '.farm-profiles');
const getProfilePath = (profileId) => {
  const dir = path.join(PROFILES_DIR, profileId.toString());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Has Chromium ever populated this dir? If not, treat as fresh and restore from sessionData.
const isProfileDirFresh = (profileId) => {
  const dir = path.join(PROFILES_DIR, profileId.toString());
  if (!fs.existsSync(dir)) return true;
  return !fs.existsSync(path.join(dir, 'Default'));
};

const buildProxyConfig = async (proxyData) => {
  const { protocol, host, port, username, password } = proxyData;
  if (!host || !port) throw new Error('Proxy host/port missing');

  const isSocks = protocol === 'socks5' || protocol === 'socks4';
  const hasAuth = !!(username && password);

  // Playwright supports HTTP/HTTPS auth and SOCKS-without-auth natively
  if (!isSocks || !hasAuth) {
    const cfg = { server: `${protocol}://${host}:${port}` };
    if (username) cfg.username = username;
    if (password) cfg.password = password;
    return { proxyConfig: cfg, cleanup: async () => {} };
  }

  // SOCKS5 + auth → bridge through proxy-chain (Playwright can't do SOCKS5 auth natively)
  const proxyChain = require('proxy-chain');
  const url = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  const localUrl = await proxyChain.anonymizeProxy(url);
  return {
    proxyConfig: { server: localUrl },
    cleanup: async () => proxyChain.closeAnonymizedProxy(localUrl, true).catch(() => {}),
  };
};

const launchFarmBrowser = async (profile, opts = {}) => {
  const fp = buildFingerprint(profile);
  const profilePath = getProfilePath(profile._id.toString());
  const dirIsFresh  = isProfileDirFresh(profile._id.toString());

  if (!profile.proxy?.host || !profile.proxy?.port) {
    throw new Error('No proxy configured — set proxy first');
  }
  const { proxyConfig, cleanup } = await buildProxyConfig(profile.proxy);

  const headless = opts.headless !== undefined ? opts.headless : true;

  const args = [
    '--no-sandbox','--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
    '--disable-infobars','--disable-dev-shm-usage',
    '--no-first-run','--no-default-browser-check',
    '--use-gl=swiftshader',
    `--window-size=${fp.viewport.width},${fp.viewport.height + 88}`,
    '--lang=en-US',
    '--disable-component-extensions-with-background-pages',
    '--disable-features=Translate,OptimizationHints',
  ];

  const context = await chromium.launchPersistentContext(profilePath, {
    headless,
    args,
    ignoreDefaultArgs: ['--enable-automation','--enable-blink-features=IdleDetection'],
    viewport:   fp.viewport,
    userAgent:  fp.userAgent,
    locale:     fp.locale,
    timezoneId: fp.timezone,
    colorScheme:'light',
    proxy:      proxyConfig,
    permissions:[],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua':        `"Not_A Brand";v="8","Chromium";v="${fp.chromeVersion}","Google Chrome";v="${fp.chromeVersion}"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': fp.platform === 'MacIntel' ? '"macOS"' : '"Windows"',
    },
  });

  await context.addInitScript(buildStealthScript(fp));

  // Only restore from sessionData if persistent dir was wiped (e.g. Railway redeploy).
  // If dir has state, persistent context already loaded cookies — adding from MongoDB
  // on top would overwrite fresh cookies with stale ones (the bug we fixed).
  if (dirIsFresh && profile.sessionData) {
    try {
      const state = JSON.parse(profile.sessionData);
      const now = Date.now() / 1000;
      const valid = (state.cookies || []).filter(c => !c.expires || c.expires === -1 || c.expires > now);
      if (valid.length > 0) await context.addCookies(valid);
    } catch {}
  }

  let page = context.pages()[0];
  if (!page) page = await context.newPage();

  if (opts.blockResources !== false) {
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'font' || t === 'media') return route.abort();
      return route.fallback();
    });
  }

  return { context, page, fp, cleanup };
};

const saveSession = async (context) => JSON.stringify(await context.storageState());

const takeScreenshot = async (page) => {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch { return null; }
};

// CDP screencast — returns { stop, cdp } so callers can also dispatch input through the same session
const startScreencast = async (page, onFrame, opts = {}) => {
  let cdp = null, stopped = false;
  const stop = async () => {
    stopped = true;
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  };
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.startScreencast', {
      format:        'jpeg',
      quality:       opts.quality || 65,
      maxWidth:      opts.maxWidth  || 1280,
      maxHeight:     opts.maxHeight || 800,
      everyNthFrame: opts.everyNthFrame || 2,
    });
    cdp.on('Page.screencastFrame', async (e) => {
      if (stopped) return;
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      if (onFrame) onFrame('data:image/jpeg;base64,' + e.data, e.metadata || {});
    });
  } catch {
    // Fallback: poll screenshots
    (async () => {
      while (!stopped) {
        const s = await takeScreenshot(page).catch(() => null);
        if (s && onFrame) onFrame(s, {});
        await sleep(800);
      }
    })();
  }
  return { stop, cdp: () => cdp };
};

// CDP input bridge — used by interactive mode to dispatch mouse/keyboard from dashboard
const createInputBridge = (cdpGetter) => {
  const dispatchMouse = async (input) => {
    const cdp = cdpGetter();
    if (!cdp) return;
    await cdp.send('Input.dispatchMouseEvent', input).catch(() => {});
  };
  const dispatchKey = async (input) => {
    const cdp = cdpGetter();
    if (!cdp) return;
    await cdp.send('Input.dispatchKeyEvent', input).catch(() => {});
  };
  const dispatchWheel = async (x, y, deltaX, deltaY) => {
    const cdp = cdpGetter();
    if (!cdp) return;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none',
    }).catch(() => {});
  };
  return { dispatchMouse, dispatchKey, dispatchWheel };
};

const humanMove = async (page, toX, toY) => {
  const fromX = toX + randInt(-100, 100);
  const fromY = toY + randInt(-60, 60);
  await page.mouse.move(fromX, fromY).catch(() => {});
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2*t*t : -1 + (4 - 2*t) * t;
    await page.mouse.move(
      Math.round(fromX + (toX - fromX) * e),
      Math.round(fromY + (toY - fromY) * e)
    ).catch(() => {});
    await sleep(randInt(6, 14));
  }
};

// — Clear helpers (used by the clear-data feature) —
const clearCookies = async (context) => { try { await context.clearCookies(); } catch {} };

const clearStorage = async (page) => {
  try {
    await page.evaluate(() => {
      try { localStorage.clear(); }   catch(e) {}
      try { sessionStorage.clear(); } catch(e) {}
      try {
        if (indexedDB.databases) {
          indexedDB.databases().then(dbs => dbs.forEach(db => db.name && indexedDB.deleteDatabase(db.name)));
        }
      } catch(e) {}
    });
  } catch {}
};

const deleteProfileDir = (profileId) => {
  const dir = path.join(PROFILES_DIR, profileId.toString());
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
};

module.exports = {
  buildFingerprint, launchFarmBrowser, saveSession,
  takeScreenshot, startScreencast, humanMove, buildProxyConfig,
  sleep, randInt, pick,
  createInputBridge,
  clearCookies, clearStorage, deleteProfileDir,
};
