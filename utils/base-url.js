// Single source of truth for the base URL embedded in outgoing emails and
// confirmation/unsubscribe pages. In production this MUST come from
// PUBLIC_BASE_URL — the previous fallback to `req.get('host')` was
// host-header-injectable: an attacker could send `Host: evil.com` and the
// resulting confirmation email would point users at evil.com.

function getBaseUrl(req) {
    const fromEnv = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (fromEnv) return fromEnv;
    if (process.env.NODE_ENV === 'production') {
        throw new Error('PUBLIC_BASE_URL must be set in production');
    }
    // Dev fallback only — never reached in prod thanks to the boot-time guard
    // in server.js. The request-derived URL is unsafe in prod but acceptable
    // for local curl-driven testing.
    return `${req.protocol}://${req.get('host')}`;
}

module.exports = { getBaseUrl };
