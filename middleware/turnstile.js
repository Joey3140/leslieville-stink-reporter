const { createChild } = require('../utils/logger');
const { getClientIp } = require('../utils/hash');

const log = createChild('turnstile');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare-published test secret keys (public): always-pass and always-fail.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_PASS_SECRET = '1x0000000000000000000000000000000AA';
const TEST_PASS_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

async function verifyTurnstile(token, ip) {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
        // Allow in dev if no key configured. Server logs warn so this is visible.
        log.warn('TURNSTILE_SECRET_KEY not configured — bypassing verification (dev only)');
        return { success: true, dev: true };
    }
    // Permit a fixed test token so curl-based smoke tests still work in CI/local.
    if (secret === TEST_PASS_SECRET && token === TEST_PASS_TOKEN) {
        return { success: true, test: true };
    }
    try {
        const body = new URLSearchParams({ secret, response: token });
        if (ip) body.set('remoteip', ip);
        const r = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const data = await r.json();
        return data;
    } catch (err) {
        log.error({ err }, 'turnstile verify error');
        return { success: false, error: 'verify-failed' };
    }
}

function turnstileMiddleware() {
    return async (req, res, next) => {
        const token = req.body?.turnstileToken;
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'turnstileToken required' });
        }
        const ip = getClientIp(req);
        const result = await verifyTurnstile(token, ip);
        if (!result.success) {
            log.info({ codes: result['error-codes'] }, 'turnstile rejected');
            return res.status(403).json({ error: 'Captcha verification failed' });
        }
        next();
    };
}

module.exports = { turnstileMiddleware, verifyTurnstile };
