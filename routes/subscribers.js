const express = require('express');
const { requireDb, COLLECTIONS, FieldValue } = require('../utils/firestore');
const { hashEmail, randomToken } = require('../utils/hash');
const { validate, validateQuery, schemas } = require('../middleware/validate');
const { createRateLimit } = require('../middleware/rate-limit');
const { turnstileMiddleware } = require('../middleware/turnstile');
const { send } = require('../utils/email');
const { asyncHandler } = require('../utils/async-handler');
const { createChild } = require('../utils/logger');
const { z } = require('zod');

const router = express.Router();
const log = createChild('routes.subscribers');

const SEV_LABEL = { 1: 'Faint', 3: 'Strong', 5: 'Overwhelming' };

const subscribeLimiter = createRateLimit({
    max: 3, windowMs: 60 * 60 * 1000, bucket: 'subscribe',
    message: 'Too many subscribe attempts from this IP, please try again later',
});

router.post('/',
    subscribeLimiter,
    turnstileMiddleware(),
    validate(schemas.subscribe),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const { email, fsas, thresholdSeverity } = req.validated;
        const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

        const emailHash = hashEmail(email);
        const subsRef = db.collection(COLLECTIONS.subscribers);
        const existing = await subsRef.where('emailHash', '==', emailHash).limit(1).get();

        let docRef;
        let unsubscribeToken;
        const now = new Date();

        if (!existing.empty) {
            // Re-subscribe / update preferences. Keep same unsubscribeToken to maintain link continuity.
            const doc = existing.docs[0];
            docRef = doc.ref;
            const data = doc.data();
            unsubscribeToken = data.unsubscribeToken || randomToken(32);
            await docRef.update({
                fsas,
                thresholdSeverity,
                unsubscribeToken,
                status: data.status === 'active' ? 'active' : 'pending',
                updatedAt: now,
            });
        } else {
            unsubscribeToken = randomToken(32);
            docRef = await subsRef.add({
                email,
                emailHash,
                fsas,
                thresholdSeverity,
                status: 'pending',
                unsubscribeToken,
                createdAt: now,
            });
        }

        const confirmToken = randomToken(32);
        await docRef.update({ confirmToken, confirmTokenIssuedAt: now });

        try {
            await send({
                to: email,
                subject: 'Confirm your Leslieville Stink Reporter alerts',
                template: 'confirm',
                data: {
                    fsasJoined: fsas.join(', '),
                    thresholdLabel: SEV_LABEL[thresholdSeverity] || `severity ${thresholdSeverity}`,
                    confirmUrl: `${baseUrl}/api/subscribers/confirm?token=${confirmToken}`,
                    baseUrl,
                },
            });
        } catch (err) {
            log.error({ err }, 'failed to send confirmation email — subscription remains pending');
            // Don't 500 the user — the doc exists; they can retry to re-issue the email.
        }

        log.info({ id: docRef.id, fsas, status: 'pending' }, 'subscriber pending confirmation');
        res.json({ ok: true, message: 'Check your email for a confirmation link.' });
    })
);

router.get('/confirm',
    validateQuery(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const { token } = req.validatedQuery;
        const snap = await db.collection(COLLECTIONS.subscribers)
            .where('confirmToken', '==', token).limit(1).get();
        if (snap.empty) {
            return res.status(404).send(htmlPage('Link expired or invalid', 'This confirmation link has already been used or has expired. <a href="/subscribe">Subscribe again</a>.'));
        }
        const doc = snap.docs[0];
        await doc.ref.update({
            status: 'active',
            confirmedAt: new Date(),
            confirmToken: FieldValue.delete(),
        });
        log.info({ id: doc.id }, 'subscriber confirmed');
        res.send(htmlPage("You're subscribed", "We'll email you when your watched areas cross a complaint threshold. <a href=\"/\">Back to the map</a>."));
    })
);

// Both POST (form) and GET (one-click email link) work for unsubscribe.
async function handleUnsubscribe(token) {
    const db = requireDb();
    const snap = await db.collection(COLLECTIONS.subscribers)
        .where('unsubscribeToken', '==', token).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    await doc.ref.update({ status: 'unsubscribed', unsubscribedAt: new Date() });
    return doc.data();
}

router.get('/unsubscribe',
    validateQuery(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const data = await handleUnsubscribe(req.validatedQuery.token);
        if (!data) {
            return res.status(404).send(htmlPage('Link expired', 'This unsubscribe link is no longer valid. If you still want off the list, <a href="/subscribe">contact us via the subscribe page</a>.'));
        }
        log.info('subscriber unsubscribed (GET)');
        res.send(htmlPage("You're unsubscribed", "We won't email you again. <a href=\"/\">Back to the map</a>."));
    })
);

router.post('/unsubscribe',
    validate(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const data = await handleUnsubscribe(req.validated.token);
        if (!data) return res.status(404).json({ error: 'Invalid token' });
        log.info('subscriber unsubscribed (POST)');
        res.json({ ok: true });
    })
);

function htmlPage(title, message) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — Leslieville Stink Reporter</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/main.css"></head>` +
        `<body><header class="masthead"><div class="brand"><a href="/"><strong>Leslieville Stink Reporter</strong></a></div></header>` +
        `<main class="prose"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

module.exports = router;
