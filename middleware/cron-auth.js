const crypto = require('crypto');
const { createChild } = require('../utils/logger');
const { hmacIp, getClientIp } = require('../utils/hash');

const log = createChild('cron-auth');

// Constant-time string compare. Length-equality short-circuit is required —
// timingSafeEqual throws when buffers differ in length, and the throw itself
// is observable. Returning `false` on a length mismatch is safe because the
// secret length is fixed (random 32-byte hex from `openssl rand -hex 32`).
function safeEqualStr(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every run (a GET) once
// CRON_SECRET is set as a project env var. Anything without that token is refused,
// so the endpoints aren't world-callable.
function cronAuth(req, res, next) {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        log.error('CRON_SECRET not configured — refusing cron requests');
        return res.status(503).json({ error: 'Cron not configured' });
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqualStr(token, expected)) {
        // Hash the IP before logging — preserves the public "no raw IP" promise.
        log.warn({ path: req.path, ipHashShort: hmacIp(getClientIp(req)).slice(0, 8) }, 'cron auth rejected');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = { cronAuth };
