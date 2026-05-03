const { getDb, COLLECTIONS } = require('../utils/firestore');
const { hmacIp, getClientIp } = require('../utils/hash');
const { createChild } = require('../utils/logger');

const log = createChild('rate-limit');

const WHITELIST_IPS = process.env.RATE_LIMIT_WHITELIST_IPS
    ? process.env.RATE_LIMIT_WHITELIST_IPS.split(',').map((ip) => ip.trim()).filter(Boolean)
    : [];

function createRateLimit({ max = 10, windowMs = 60 * 60 * 1000, bucket = 'default', message = 'Too many requests, please try again later' } = {}) {
    return async function rateLimit(req, res, next) {
        const db = getDb();
        if (!db) {
            log.error({ bucket }, 'Firestore unavailable — blocking request');
            return res.status(503).json({ error: 'Service temporarily unavailable' });
        }

        const ip = getClientIp(req);
        if (WHITELIST_IPS.includes(ip)) return next();

        const ipHash = hmacIp(ip);
        const docId = `${bucket}_${ipHash}`;
        const docRef = db.collection(COLLECTIONS.rateLimits).doc(docId);

        try {
            const now = Date.now();
            const windowStart = now - windowMs;

            const snap = await docRef.get();
            let attempts = [];
            if (snap.exists) {
                attempts = (snap.data().attempts || []).filter((ts) => ts > windowStart);
            }

            if (attempts.length >= max) {
                const oldest = Math.min(...attempts);
                const resetAt = oldest + windowMs;
                res.setHeader('X-RateLimit-Limit', max);
                res.setHeader('X-RateLimit-Remaining', 0);
                res.setHeader('X-RateLimit-Reset', new Date(resetAt).toISOString());
                log.info({ bucket, ipHashShort: ipHash.slice(0, 8), attempts: attempts.length, max }, 'rate limit blocked');
                return res.status(429).json({
                    error: message,
                    retryAfter: Math.ceil((resetAt - now) / 1000),
                });
            }

            attempts.push(now);
            const expiresAt = new Date(now + windowMs);
            await docRef.set({ attempts, bucket, expiresAt, updatedAt: new Date() });

            res.setHeader('X-RateLimit-Limit', max);
            res.setHeader('X-RateLimit-Remaining', max - attempts.length);
            next();
        } catch (err) {
            log.error({ err, bucket }, 'rate limit error');
            return res.status(503).json({ error: 'Service temporarily unavailable' });
        }
    };
}

module.exports = { createRateLimit };
