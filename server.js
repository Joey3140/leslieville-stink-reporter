const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const admin = require('firebase-admin');
require('dotenv').config();

const { createChild } = require('./utils/logger');
const log = createChild('server');

process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled Promise Rejection');
});
process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught Exception');
    process.exit(1);
});

if (!admin.apps.length) {
    try {
        let credential;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            credential = admin.credential.cert(serviceAccount);
            log.info('Using Firebase service account from environment');
        } else {
            credential = admin.credential.applicationDefault();
            log.info('Using Firebase application default credentials');
        }
        admin.initializeApp({ credential });
        log.info('Firebase Admin initialized');
    } catch (err) {
        log.error({ err }, 'Firebase Admin initialization error — Firestore features may not work');
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            'default-src': ["'self'"],
            // No 'unsafe-inline' — every script in /public is loaded from a same-origin file.
            'script-src': ["'self'", 'https://challenges.cloudflare.com', 'https://unpkg.com'],
            // 'unsafe-inline' kept for style-src because Leaflet writes inline styles on map tiles.
            'style-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://fonts.googleapis.com'],
            'img-src': ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],
            'connect-src': ["'self'", 'https://challenges.cloudflare.com'],
            'frame-src': ["'self'", 'https://challenges.cloudflare.com'],
            'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
    log.debug({ method: req.method, path: req.path, ip: req.ip }, 'request');
    next();
});

app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
        turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
        submissionsPaused: process.env.SUBMISSIONS_PAUSED === 'true',
    });
});

// TEMPORARY diagnostic — confirms which critical env vars Vercel's runtime sees.
// Returns presence (boolean) and length only, never the value. Remove after first
// successful smoke test against production.
app.get('/api/diag/env', (req, res) => {
    const keys = ['FIREBASE_SERVICE_ACCOUNT', 'FIRESTORE_DATABASE_ID', 'TURNSTILE_SITE_KEY',
        'TURNSTILE_SECRET_KEY', 'RESEND_API_KEY', 'IP_HASH_SECRET', 'CRON_SECRET',
        'PUBLIC_BASE_URL', 'NODE_ENV'];
    const out = {};
    keys.forEach((k) => {
        const v = process.env[k];
        out[k] = { present: typeof v === 'string' && v.length > 0, length: v ? v.length : 0 };
    });
    // Special: surface the actual FIRESTORE_DATABASE_ID value (it's not a secret — just a name)
    out.FIRESTORE_DATABASE_ID_value = process.env.FIRESTORE_DATABASE_ID || null;
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
});

const reportsRoutes = require('./routes/reports');
app.use('/api/reports', reportsRoutes);

const subscribersRoutes = require('./routes/subscribers');
app.use('/api/subscribers', subscribersRoutes);

const alertsRoutes = require('./routes/alerts');
app.use('/api/cron', alertsRoutes);

app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: '1h',
}));

const sendPage = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/', sendPage('index.html'));
app.get('/report', sendPage('report.html'));
app.get('/subscribe', sendPage('subscribe.html'));
app.get('/about', sendPage('about.html'));
app.get('/unsubscribe', sendPage('unsubscribe.html'));

app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
    log.error({ err, path: req.path, method: req.method }, 'Unhandled route error');
    if (req.path.startsWith('/api/')) {
        return res.status(500).json({ error: 'Something went wrong' });
    }
    res.status(500).sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        log.info({ port: PORT }, 'Leslieville Stink Reporter running');
    });
}

module.exports = app;
