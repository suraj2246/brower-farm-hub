// In-memory share session store. Survives until server restart, which is acceptable
// for password-protected share links (worst case: user re-enters password).

const _shareSessions = new Map();
const SHARE_SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours

const createShareSession = (profileId, shareToken) => {
  const { nanoid } = require('nanoid');
  const sessionToken = nanoid(32);
  const expiresAt = Date.now() + SHARE_SESSION_TTL;
  _shareSessions.set(sessionToken, { profileId, shareToken, expiresAt });
  return { sessionToken, expiresAt };
};

const verifyShareSession = (sessionToken) => {
  if (!sessionToken) return null;
  const s = _shareSessions.get(sessionToken);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { _shareSessions.delete(sessionToken); return null; }
  return s;
};

const revokeShareSession = (sessionToken) => _shareSessions.delete(sessionToken);

// Cleanup every hour
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _shareSessions.entries()) {
    if (v.expiresAt < now) _shareSessions.delete(k);
  }
}, 60 * 60 * 1000);

module.exports = { createShareSession, verifyShareSession, revokeShareSession };
