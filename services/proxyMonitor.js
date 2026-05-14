const axios = require('axios');

const TEST_URL      = 'https://api.ipify.org?format=json';
const PING_INTERVAL = 30000;
const MAX_FAILS     = 2;

const buildAgent = (proxy) => {
  const { protocol, host, port, username, password } = proxy;
  const url = (username && password)
    ? `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
    : `${protocol}://${host}:${port}`;
  if (protocol === 'socks5' || protocol === 'socks4') {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(url);
};

const startMonitor = (proxy, onKill, log, opts = {}) => {
  let stopped = false;
  let consecutiveFails = 0;
  let lastIp = null;
  const tolerateIpRotation = !!opts.tolerateIpRotation;
  const agent = buildAgent(proxy); // cache once per monitor

  const check = async () => {
    if (stopped) return;
    try {
      const res = await axios.get(TEST_URL, {
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 10000,
      });
      const ip = res.data?.ip || 'unknown';
      consecutiveFails = 0;

      if (lastIp && lastIp !== ip && !tolerateIpRotation) {
        stopped = true;
        log('warning', `[ProxyMonitor] IP rotated mid-session: ${lastIp} → ${ip}`);
        onKill(`Proxy IP rotated (${lastIp} → ${ip})`);
        return;
      }
      lastIp = ip;
      log('info', `[ProxyMonitor] OK — IP: ${ip}`);
    } catch (e) {
      consecutiveFails++;
      log('warning', `[ProxyMonitor] Ping fail ${consecutiveFails}/${MAX_FAILS}: ${e.message}`);
      if (consecutiveFails >= MAX_FAILS) {
        stopped = true;
        log('error', '[ProxyMonitor] Proxy unreachable — killing session');
        onKill(`Proxy unreachable after ${MAX_FAILS} consecutive failures`);
      }
    }
  };

  check();
  const interval = setInterval(() => {
    if (stopped) { clearInterval(interval); return; }
    check();
  }, PING_INTERVAL);

  return () => { stopped = true; clearInterval(interval); };
};

const verifyProxy = async (proxy) => {
  try {
    const agent = buildAgent(proxy);
    const res = await axios.get(TEST_URL, {
      httpsAgent: agent,
      httpAgent: agent,
      timeout: 12000,
    });
    return { ok: true, ip: res.data?.ip || 'unknown' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

module.exports = { startMonitor, verifyProxy };
