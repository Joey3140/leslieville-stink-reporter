const { createChild } = require('../utils/logger');

const log = createChild('cron-auth');

// Vercel cron hits the path with no Bearer by default. We require explicit auth so the
// endpoint isn't world-callable. Configure CRON_SECRET in env, then in Vercel project
// settings add it to the cron's HTTP request headers (Vercel Cron > Edit > Headers).
function cronAuth(req, res, next) {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        log.error('CRON_SECRET not configured — refusing cron requests');
        return res.status(503).json({ error: 'Cron not configured' });
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== expected) {
        log.warn({ path: req.path, ip: req.ip }, 'cron auth rejected');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = { cronAuth };
