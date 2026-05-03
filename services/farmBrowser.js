/**
 * farmBrowser.js — Stealth Browser for Browser Farm
 * Adapted from SocialHub Engine's browser.js — same fingerprinting, same stealth.
 * Simplified: no account creation machinery, just warming sessions.
 */

const { chromium } = require('playwright');
const path = require('fs');
const fs   = require('fs');

const ALL_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
];
const VIEWPORTS = [
  { width: 1366, height: 768  },
  { width: 1440, height: 900  },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800  },
];
const WEBGL_RENDERERS = [
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
];
const WEBGL_VENDORS = ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)'];

const COUNTRY_TIMEZONES = {
  US: ['America/New_York','America/Chicago','America/Los_Angeles'],
  GB: ['Europe/London'],
  IN: ['Asia/Kolkata'],
  AU: ['Australia/Sydney'],
  CA: ['America/Toronto','America/Vancouver'],
  DE: ['Europe/Berlin'],
  DEFAULT: ['America/New_York','America/Chicago'],
};

const sleep   = (ms)       => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const rand    = (arr)      => arr[Math.floor(Math.random() * arr.length)];

// ── Build fingerprint from stored profile data ─────────────────────────────
// If profile already has a fingerprint (from DB), use it — consistency is key.
// First-time: generate fresh and save back to profile.
const buildFingerprint = (profile) => {
  if (profile.fingerprint && profile.fingerprint.userAgent) {
    return profile.fingerprint;
  }
  const seed  = Date.now() % 999999;
  const r     = (max, o=0) => ((seed * 9301 + o * 49297) % 233280) % max;
  const ua    = ALL_UAS[r(ALL_UAS.length)];
  const isMac = ua.includes('Macintosh');
  const chromeVer = (ua.match(/Chrome\/(\d+)/) || ['','135'])[1];
  const tzPool = COUNTRY_TIMEZONES.US;
  return {
    userAgent:    ua,
    viewport:     VIEWPORTS[r(VIEWPORTS.length, 1)],
    timezone:     tzPool[r(tzPool.length, 2)],
    locale:       'en-US',
    platform:     isMac ? 'MacIntel' : 'Win32',
    cpuCores:     [4,4,6,8][r(4,5)],
    deviceMem:    [4,8,8][r(3,6)],
    webglVendor:  WEBGL_VENDORS[r(WEBGL_VENDORS.length, 7)],
    webglRenderer:WEBGL_RENDERERS[r(WEBGL_RENDERERS.length, 8)],
    canvasSeed:   (seed * 1234567 + 987654) % 9999999,
    audioSeed:    ((seed * 7654321) % 999999) / 999999,
    chromeVersion: chromeVer,
  };
};

// ── Stealth injection script ──────────────────────────────────────────────────
const buildStealthScript = (fp) => `(function(){
Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});
const _cdcKeys=Object.getOwnPropertyNames(window).filter(k=>k.startsWith('cdc_')||k.startsWith('__playwright')||k.startsWith('__pw_')||k==='_playwright');
_cdcKeys.forEach(k=>{try{delete window[k];}catch(e){}});
Object.defineProperty(navigator,'platform',{get:()=>'${fp.platform}'});
Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>${fp.cpuCores}});
Object.defineProperty(navigator,'deviceMemory',{get:()=>${fp.deviceMem}});
Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
Object.defineProperty(screen,'availWidth',{get:()=>${fp.viewport.width}});
Object.defineProperty(screen,'availHeight',{get:()=>Math.round(${fp.viewport.height}*0.94)});
Object.defineProperty(window,'outerWidth',{get:()=>${fp.viewport.width}});
Object.defineProperty(window,'outerHeight',{get:()=>${fp.viewport.height}});
Object.defineProperty(window,'devicePixelRatio',{get:()=>1});
const _cs=${fp.canvasSeed};
const oTDU=HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL=function(t){const c=this.getContext('2d');if(c){const id=c.getImageData(0,0,this.width||1,this.height||1);for(let i=0;i<id.data.length;i+=4){id.data[i]^=(_cs*(i+1))%3;}c.putImageData(id,0,0);}return oTDU.apply(this,arguments);};
const _patchWebGL=(Ctx)=>{if(!Ctx)return;const gP=Ctx.prototype.getParameter;Ctx.prototype.getParameter=function(p){if(p===37445)return '${fp.webglVendor}';if(p===37446)return '${fp.webglRenderer}';return gP.apply(this,arguments);};};
_patchWebGL(window.WebGLRenderingContext);try{_patchWebGL(window.WebGL2RenderingContext);}catch(e){}
window.chrome={app:{isInstalled:false},runtime:{id:undefined,connect:()=>{throw new Error('Extension context invalidated.');},sendMessage:()=>{throw new Error('Extension context invalidated.');}},loadTimes:()=>({}),csi:()=>({})};
if(navigator.mediaDevices&&navigator.mediaDevices.enumerateDevices){navigator.mediaDevices.enumerateDevices=()=>Promise.resolve([{deviceId:'default',kind:'audioinput',label:''},{deviceId:'default',kind:'audiooutput',label:''}].map(d=>Object.assign(Object.create(MediaDeviceInfo.prototype),d)));}
try{if(window.speechSynthesis){const _fv=[{voiceURI:'Microsoft Zira',name:'Microsoft Zira - English (United States)',lang:'en-US',localService:true,default:true}].map(v=>Object.assign(Object.create(SpeechSynthesisVoice.prototype),v));window.speechSynthesis.getVoices=()=>_fv;}}catch(e){}
if(!performance.memory){Object.defineProperty(performance,'memory',{get:()=>({jsHeapSizeLimit:2172649472,totalJSHeapSize:${fp.cpuCores}*1024*1024*40,usedJSHeapSize:${fp.cpuCores}*1024*1024*25})});}
})();`;

// ── Profile dir for persistent context ───────────────────────────────────────
const PROFILES_DIR = require('path').join(process.cwd(), '.farm-profiles');
const getProfilePath = (profileId) => {
  const dir = require('path').join(PROFILES_DIR, profileId.toString());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ── Build Playwright proxy config for authenticated SOCKS5 ───────────────────
const buildProxyConfig = async (proxyData) => {
  const { protocol, host, port, username, password } = proxyData;
  if (!host || !port) throw new Error('Proxy host/port missing');

  const isSocks = protocol === 'socks5' || protocol === 'socks4';
  const hasAuth  = !!(username && password);

  if (!isSocks || !hasAuth) {
    const cfg = { server: `${protocol}://${host}:${port}` };
    if (username) cfg.username = username;
    if (password) cfg.password = password;
    return { proxyConfig: cfg, cleanup: async () => {} };
  }

  // SOCKS5 + auth → proxy-chain bridge (Playwright can't do SOCKS5 auth natively)
  const proxyChain = require('proxy-chain');
  const url = `${protocol}://${username}:${password}@${host}:${port}`;
  const localUrl = await proxyChain.anonymizeProxy(url);
  return {
    proxyConfig: { server: localUrl },
    cleanup: async () => proxyChain.closeAnonymizedProxy(localUrl, true).catch(() => {}),
  };
};

// ── Launch farm browser ───────────────────────────────────────────────────────
const launchFarmBrowser = async (profile) => {
  const fp          = buildFingerprint(profile);
  const profilePath = getProfilePath(profile._id.toString());
  const chromeVer   = fp.chromeVersion;

  const { proxyConfig, cleanup } = await buildProxyConfig(profile.proxy);

  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check',
    '--use-gl=swiftshader', '--use-angle=swiftshader-webgl',
    `--window-size=${fp.viewport.width},${fp.viewport.height + 88}`,
    '--lang=en-US',
  ];

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    args,
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
    viewport:    fp.viewport,
    userAgent:   fp.userAgent,
    locale:      fp.locale,
    timezoneId:  fp.timezone,
    colorScheme: 'light',
    proxy:       proxyConfig,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': `"Not_A Brand";v="8","Chromium";v="${chromeVer}","Google Chrome";v="${chromeVer}"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': fp.platform === 'MacIntel' ? '"macOS"' : '"Windows"',
    },
  });

  await context.addInitScript(buildStealthScript(fp));

  // Restore saved session if exists
  if (profile.sessionData) {
    try {
      const state = JSON.parse(profile.sessionData);
      const now   = Date.now() / 1000;
      const valid = (state.cookies || []).filter(c => !c.expires || c.expires === -1 || c.expires > now);
      if (valid.length > 0) await context.addCookies(valid);
    } catch {}
  }

  const page = await context.newPage();
  await page.route('**/*', (route) => {
    if (['font','media'].includes(route.request().resourceType())) return route.abort();
    route.fallback();
  });

  return { context, page, fp, cleanup };
};

// ── Save session state back to profile ───────────────────────────────────────
const saveSession = async (context) => JSON.stringify(await context.storageState());

// ── Screenshot helper ─────────────────────────────────────────────────────────
const takeScreenshot = async (page) => {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch { return null; }
};

// ── Live screencast (CDP → socket) ───────────────────────────────────────────
const startScreencast = async (page, onFrame) => {
  let cdpSession = null, stopped = false;
  const stop = async () => {
    stopped = true;
    if (cdpSession) await cdpSession.send('Page.stopScreencast').catch(() => {});
  };
  try {
    cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg', quality: 65, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2,
    });
    cdpSession.on('Page.screencastFrame', async (e) => {
      if (stopped) return;
      cdpSession.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      if (onFrame) onFrame('data:image/jpeg;base64,' + e.data);
    });
  } catch {
    // Fallback to interval screenshots
    (async () => {
      while (!stopped) {
        const s = await takeScreenshot(page).catch(() => null);
        if (s && onFrame) onFrame(s);
        await sleep(800);
      }
    })();
  }
  return stop;
};

// ── Bezier mouse movement ─────────────────────────────────────────────────────
const humanMove = async (page, toX, toY) => {
  const fromX = toX + randInt(-100, 100);
  const fromY = toY + randInt(-60, 60);
  await page.mouse.move(fromX, fromY);
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    await page.mouse.move(
      Math.round(fromX + (toX - fromX) * e),
      Math.round(fromY + (toY - fromY) * e)
    );
    await sleep(randInt(6, 14));
  }
};

module.exports = {
  buildFingerprint, launchFarmBrowser, saveSession,
  takeScreenshot, startScreencast, humanMove,
  buildProxyConfig, sleep, randInt, rand,
};
