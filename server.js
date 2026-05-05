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

// PUBLIC_BASE_URL drives every URL embedded in outgoing emails and confirm/unsubscribe
// pages. Without it, routes would have to fall back to req.get('host'), which is
// attacker-controllable via the Host header. Refuse to start rather than serve
// host-header-injectable links in production.
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_BASE_URL) {
    log.fatal('PUBLIC_BASE_URL must be set in production — refusing to start.');
    process.exit(1);
}

// Subscriber emails are encrypted at rest with AES-256-GCM. Without the key,
// the alert cron can't decrypt addresses to send to and new signups can't be
// stored — refuse to start rather than fail silently per-request.
if (process.env.NODE_ENV === 'production' && !process.env.SUBSCRIBER_EMAIL_KEY) {
    log.fatal('SUBSCRIBER_EMAIL_KEY must be set in production — refusing to start.');
    process.exit(1);
}

// Lenient parse: tolerates trailing whitespace, newlines, or stray characters that
// commonly appear when pasting a long JSON blob into a hosting provider's env-var UI.
// Walks the string once, returns the first balanced top-level object.
function parseServiceAccountJson(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_e) { /* fall through */ }
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) { esc = false; }
            else if (c === '\\') { esc = true; }
            else if (c === '"') { inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') { if (start === -1) start = i; depth++; }
        else if (c === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                const slice = s.slice(start, i + 1);
                log.warn({ originalLen: s.length, parsedLen: slice.length }, 'FIREBASE_SERVICE_ACCOUNT had trailing content — used first valid JSON object');
                return JSON.parse(slice);
            }
        }
    }
    throw new Error('FIREBASE_SERVICE_ACCOUNT did not contain a valid JSON object');
}

if (!admin.apps.length) {
    try {
        let credential;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = parseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT);
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
            // unpkg.com allowed for Leaflet sourcemap fetches; no real connect traffic.
            'connect-src': ["'self'", 'https://challenges.cloudflare.com', 'https://unpkg.com'],
            'frame-src': ["'self'", 'https://challenges.cloudflare.com'],
            'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '128kb' }));
// Tight 8kb cap for form posts — only used by the confirm/unsubscribe HTML pages,
// which submit a single token field. Prevents a misuse vector while keeping the
// browser-form-post flow working.
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
    // No raw IP — debug-level only emits in dev, but keep the privacy promise honest
    // by never putting req.ip into a log record at any level.
    log.debug({ method: req.method, path: req.path }, 'request');
    next();
});

app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
        turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
        submissionsPaused: process.env.SUBMISSIONS_PAUSED === 'true',
    });
});


const reportsRoutes = require('./routes/reports');
app.use('/api/reports', reportsRoutes);

const subscribersRoutes = require('./routes/subscribers');
app.use('/api/subscribers', subscribersRoutes);

const alertsRoutes = require('./routes/alerts');
app.use('/api/cron', alertsRoutes);

const weatherRoutes = require('./routes/weather');
app.use('/api/weather', weatherRoutes);

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
