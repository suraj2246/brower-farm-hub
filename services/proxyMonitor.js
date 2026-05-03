/**
 * proxyMonitor.js — Proxy Kill Switch
 *
 * Runs alongside every warming session. Pings the proxy every 30s.
 * Two consecutive failures = proxy is dead/rotated → immediately closes
 * the browser context so no requests leak through bare IP.
 */

const axios = require('axios');

const TEST_URL     = 'https://api.ipify.org?format=json';
const PING_INTERVAL = 30000; // 30s between checks
const MAX_FAILS     = 2;     // consecutive failures before kill

const buildAgent = (proxy) => {
  const { protocol, host, port, username, password } = proxy;
  const url = (username && password)
    ? `${protocol}://${username}:${password}@${host}:${port}`
    : `${protocol}://${host}:${port}`;

  if (protocol === 'socks5' || protocol === 'socks4') {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(url);
};

/**
 * Start monitoring proxy health for a session.
 *
 * @param {object} proxy     - proxy config { protocol, host, port, username, password }
 * @param {function} onKill  - called with reason string when proxy is dead
 * @param {function} log     - logging function
 * @returns {function} stop  - call this to stop monitoring (on clean session end)
 */
const startMonitor = (proxy, onKill, log) => {
  let stopped      = false;
  let consecutiveFails = 0;
  let lastIp       = null;

  const check = async () => {
    if (stopped) return;

    try {
      const agent = buildAgent(proxy);
      const res   = await axios.get(TEST_URL, {
        httpsAgent: agent,
        timeout:    10000,
      });

      const ip = res.data?.ip || 'unknown';
      consecutiveFails = 0;

      if (lastIp && lastIp !== ip) {
        // IP changed mid-session — rotating proxy, kill immediately
        log('warning', `[ProxyMonitor] IP changed: ${lastIp} → ${ip} — KILLING SESSION`);
        stopped = true;
        onKill(`Proxy IP rotated mid-session (${lastIp} → ${ip})`);
        return;
      }

      lastIp = ip;
      log('info', `[ProxyMonitor] Proxy OK — IP: ${ip}`);

    } catch (e) {
      consecutiveFails++;
      log('warning', `[ProxyMonitor] Ping failed (${consecutiveFails}/${MAX_FAILS}): ${e.message}`);

      if (consecutiveFails >= MAX_FAILS) {
        stopped = true;
        log('error', `[ProxyMonitor] Proxy dead — KILLING SESSION (internet cut)`);
        onKill(`Proxy unreachable after ${MAX_FAILS} consecutive failures`);
      }
    }
  };

  // Initial check before starting the interval
  check();
  const interval = setInterval(() => {
    if (stopped) { clearInterval(interval); return; }
    check();
  }, PING_INTERVAL);

  const stop = () => {
    stopped = true;
    clearInterval(interval);
  };

  return stop;
};

/**
 * One-shot proxy test — used before launching a browser.
 * Throws if proxy is unreachable so we never open a browser without a working proxy.
 */
const verifyProxy = async (proxy) => {
  try {
    const agent = buildAgent(proxy);
    const res   = await axios.get(TEST_URL, { httpsAgent: agent, timeout: 12000 });
    return { ok: true, ip: res.data?.ip || 'unknown' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

module.exports = { startMonitor, verifyProxy };
