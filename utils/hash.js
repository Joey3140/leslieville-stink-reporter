const crypto = require('crypto');

function hmacIp(ip) {
    const secret = process.env.IP_HASH_SECRET;
    if (!secret || secret.length < 16) {
        // Fallback for local/dev — never use in prod (env should be set).
        return crypto.createHash('sha256').update(`fallback:${ip}`).digest('hex').slice(0, 32);
    }
    return crypto.createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

function hashEmail(email) {
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

// Resolves the real client IP for rate-limit/dedup keying.
//
// We rely on Express's `trust proxy: true` (set in server.js) to walk the
// X-Forwarded-For chain right-to-left and stop at the first untrusted hop —
// which on Vercel is the actual client. Reading XFF[0] directly (the previous
// implementation) trusted client-supplied data, which let an attacker spoof
// `X-Forwarded-For: 1.2.3.4, real-attacker-ip` to rotate the rate-limit bucket
// on every request and bypass throttling entirely.
//
// req.ip is the canonical answer when trust-proxy is configured; the socket
// fallback covers local-dev where headers aren't injected.
function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Deterministic per-(ipHash,dayKey) lat/lng jitter. Same reporter → same offset all day.
// Defeats triangulation-by-volume: an attacker submitting 50 reports from one address
// sees all 50 dots land on the same jittered point, not the centroid of their address.
function deterministicJitter(lat, lng, ipHash, dayKey, magnitude = 0.0008) {
    const secret = process.env.IP_HASH_SECRET || 'fallback';
    const seed = crypto.createHmac('sha256', secret).update(`${ipHash}|${dayKey}`).digest();
    const a = seed.readUInt32BE(0) / 0xFFFFFFFF;   // [0,1]
    const b = seed.readUInt32BE(4) / 0xFFFFFFFF;
    const dlat = (a - 0.5) * 2 * magnitude;
    const dlng = (b - 0.5) * 2 * magnitude;
    return {
        lat: Math.round((lat + dlat) * 1000) / 1000,
        lng: Math.round((lng + dlng) * 1000) / 1000,
    };
}

module.exports = { hmacIp, hashEmail, randomToken, getClientIp, deterministicJitter };
