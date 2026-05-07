const express = require('express');
const { requireDb, COLLECTIONS, FieldValue } = require('../utils/firestore');
const { hashEmail, randomToken } = require('../utils/hash');
const { encryptEmail } = require('../utils/email-crypto');
const { validate, validateQuery, schemas } = require('../middleware/validate');
const { createRateLimit } = require('../middleware/rate-limit');
const { turnstileMiddleware } = require('../middleware/turnstile');
const { send } = require('../utils/email');
const { asyncHandler } = require('../utils/async-handler');
const { createChild } = require('../utils/logger');
const { getBaseUrl } = require('../utils/base-url');
const { z } = require('zod');

const router = express.Router();
const log = createChild('routes.subscribers');

const SEV_LABEL = { 1: 'Faint', 3: 'Strong', 5: 'Overwhelming' };

// Confirm tokens expire 7 days after issue. Without this, a confirmation
// link mailed months ago still works — anyone who later gains read access to
// an old inbox can flip a long-stale subscription to active.
const CONFIRM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Per-email cooldown on confirmation re-sends. The 3/hour subscribe rate
// limit is per-IP, so an attacker with a fresh Turnstile token from a
// residential IP could otherwise trigger up to 3 confirmation emails per
// hour to any victim address. With this cooldown the same address gets at
// most one confirmation email every 5 minutes regardless of source IP.
const CONFIRM_RESEND_COOLDOWN_MS = 5 * 60 * 1000;

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
        const baseUrl = getBaseUrl(req);

        const emailHash = hashEmail(email);
        const subsRef = db.collection(COLLECTIONS.subscribers);
        const existing = await subsRef.where('emailHash', '==', emailHash).limit(1).get();

        let docRef;
        let unsubscribeToken;
        const now = new Date();

        // Per-email confirm-resend cooldown. Bail BEFORE writing pendingFsas
        // or generating a new confirmToken — otherwise a flood of subscribe
        // calls from rotating IPs could repeatedly stash pendingFsas and burn
        // Firestore writes against a victim's record without ever mailing
        // them. The response shape is identical to a normal accept so the
        // existence of the email is not exposed.
        //
        // Scoped to status==='pending' so a user who confirmed-then-unsubscribed
        // (or confirmed-then-resubscribed within 5 min) doesn't hit a stale
        // cooldown driven by a confirmTokenIssuedAt left behind from earlier
        // in the lifecycle. Active and unsubscribed users always proceed.
        if (!existing.empty && existing.docs[0].data().status === 'pending') {
            const lastIssuedAt = existing.docs[0].data().confirmTokenIssuedAt?.toDate?.();
            if (lastIssuedAt && (now.getTime() - lastIssuedAt.getTime()) < CONFIRM_RESEND_COOLDOWN_MS) {
                log.info({ id: existing.docs[0].id }, 'subscribe deduped — confirm cooldown active');
                return res.json({ ok: true, message: 'Check your email for a confirmation link.' });
            }
        }

        if (!existing.empty) {
            // Existing record. Behaviour depends on current status:
            //  - active: stash the new prefs as `pending*` fields and require a confirm
            //    click before applying. Prevents an attacker who knows the email from
            //    silently changing fsas/threshold without ever clicking through.
            //  - pending or unsubscribed: overwrite directly — no harm yet (the user
            //    hasn't confirmed), and overwriting "unsubscribed" lets them re-subscribe.
            const doc = existing.docs[0];
            docRef = doc.ref;
            const data = doc.data();
            unsubscribeToken = data.unsubscribeToken || randomToken(32);
            if (data.status === 'active') {
                await docRef.update({
                    unsubscribeToken,
                    pendingFsas: fsas,
                    pendingThresholdSeverity: thresholdSeverity,
                    updatedAt: now,
                });
            } else {
                await docRef.update({
                    fsas,
                    thresholdSeverity,
                    unsubscribeToken,
                    status: 'pending',
                    updatedAt: now,
                });
            }
        } else {
            unsubscribeToken = randomToken(32);
            docRef = await subsRef.add({
                // Stored encrypted at rest; the original plaintext stays in scope below
                // so the immediate confirmation email still uses the user-typed address.
                email: encryptEmail(email),
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

// GET /confirm — render a confirmation page with a POST button. Does NOT confirm
// on its own. This protects against email-scanner pre-fetch (Gmail Safe Links,
// Outlook Defender) silently activating subscriptions before the user clicks.
router.get('/confirm',
    validateQuery(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const { token } = req.validatedQuery;
        const snap = await db.collection(COLLECTIONS.subscribers)
            .where('confirmToken', '==', token).limit(1).get();
        if (snap.empty || isConfirmTokenExpired(snap.docs[0].data())) {
            return res.status(404).send(htmlPage('Link expired or invalid', 'This confirmation link has already been used or has expired. <a href="/subscribe">Subscribe again</a>.'));
        }
        res.send(htmlActionPage({
            title: 'Confirm your alert subscription',
            message: 'Click the button below to activate your subscription. You can unsubscribe any time with one click from any alert email.',
            actionPath: '/api/subscribers/confirm',
            token,
            buttonLabel: 'Confirm subscription',
        }));
    })
);

// POST /confirm — actually flips status to active and applies any pending
// preference changes stashed by the subscribe handler.
router.post('/confirm',
    validate(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const { token } = req.validated;
        const snap = await db.collection(COLLECTIONS.subscribers)
            .where('confirmToken', '==', token).limit(1).get();
        if (snap.empty || isConfirmTokenExpired(snap.docs[0].data())) {
            return res.status(404).send(htmlPage('Link expired or invalid', 'This confirmation link has already been used or has expired. <a href="/subscribe">Subscribe again</a>.'));
        }
        const doc = snap.docs[0];
        const data = doc.data();
        const updates = {
            status: 'active',
            confirmedAt: new Date(),
            confirmToken: FieldValue.delete(),
        };
        // Apply any stashed preference changes (set when an already-active subscriber
        // re-submitted the subscribe form with new fsas/threshold).
        if (data.pendingFsas) {
            updates.fsas = data.pendingFsas;
            updates.pendingFsas = FieldValue.delete();
        }
        if (data.pendingThresholdSeverity != null) {
            updates.thresholdSeverity = data.pendingThresholdSeverity;
            updates.pendingThresholdSeverity = FieldValue.delete();
        }
        await doc.ref.update(updates);
        log.info({ id: doc.id, appliedPending: !!data.pendingFsas }, 'subscriber confirmed');
        res.send(htmlPage("You're subscribed", "We'll email you when your watched areas cross a complaint threshold. <a href=\"/\">Back to the map</a>."));
    })
);

// GET /unsubscribe — render a confirmation page. Email-scanner pre-fetch lands
// here without unsubscribing. Click → POST /unsubscribe to actually act.
router.get('/unsubscribe',
    validateQuery(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const { token } = req.validatedQuery;
        const snap = await db.collection(COLLECTIONS.subscribers)
            .where('unsubscribeToken', '==', token).limit(1).get();
        if (snap.empty) {
            return res.status(404).send(htmlPage('Link expired', 'This unsubscribe link is no longer valid. If you still want off the list, <a href="/subscribe">re-subscribe and unsubscribe from there</a>.'));
        }
        res.send(htmlActionPage({
            title: 'Unsubscribe from alerts',
            message: "Click the button below to confirm. You won't receive any more emails from this site.",
            actionPath: '/api/subscribers/unsubscribe',
            token,
            buttonLabel: 'Unsubscribe',
            buttonStyle: 'destructive',
        }));
    })
);

// POST /unsubscribe — accepts both URL-encoded form posts (from the GET page above)
// and JSON API posts (from any future programmatic client). Detects on Content-Type.
router.post('/unsubscribe',
    validate(z.object({ token: z.string().min(16).max(128) })),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const { token } = req.validated;
        const isFormPost = (req.headers['content-type'] || '').includes('application/x-www-form-urlencoded');

        const snap = await db.collection(COLLECTIONS.subscribers)
            .where('unsubscribeToken', '==', token).limit(1).get();
        if (snap.empty) {
            if (isFormPost) {
                return res.status(404).send(htmlPage('Link expired', 'This unsubscribe link is no longer valid.'));
            }
            return res.status(404).json({ error: 'Invalid token' });
        }
        const doc = snap.docs[0];
        await doc.ref.update({
            status: 'unsubscribed',
            unsubscribedAt: new Date(),
            // Single-use: invalidate the token so a replay (e.g. scanner re-fetch)
            // gets a clean 404 rather than another no-op write.
            unsubscribeToken: FieldValue.delete(),
        });
        log.info({ id: doc.id, source: isFormPost ? 'form' : 'json' }, 'subscriber unsubscribed');
        if (isFormPost) {
            return res.send(htmlPage("You're unsubscribed", "We won't email you again. <a href=\"/\">Back to the map</a>."));
        }
        res.json({ ok: true });
    })
);

// Treats a confirmToken as expired once CONFIRM_TOKEN_TTL_MS has passed since
// it was issued. Records missing `confirmTokenIssuedAt` (legacy rows from
// before this rollout) are treated as not-expired so existing pending
// subscribers can still confirm.
function isConfirmTokenExpired(data) {
    const issuedAt = data?.confirmTokenIssuedAt?.toDate?.();
    if (!issuedAt) return false;
    return (Date.now() - issuedAt.getTime()) > CONFIRM_TOKEN_TTL_MS;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// htmlPage: status pages. `message` is trusted server-supplied HTML (may contain links),
// title is escaped defensively.
function htmlPage(title, message) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Leslieville Stink Reporter</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/main.css"></head>` +
        `<body><header class="masthead"><div class="brand"><a href="/"><strong>Leslieville Stink Reporter</strong></a></div></header>` +
        `<main class="prose"><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

// htmlActionPage: confirmation pages with a POST form. Both title and message are
// escaped, and the token is escaped before embedding (defense-in-depth — schema
// already constrains it to 16-128 chars matching the validator).
function htmlActionPage({ title, message, actionPath, token, buttonLabel, buttonStyle = 'primary' }) {
    const buttonBg = buttonStyle === 'destructive' ? '#DA291C' : '#1B1B1B';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Leslieville Stink Reporter</title>` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/main.css"></head>` +
        `<body><header class="masthead"><div class="brand"><a href="/"><strong>Leslieville Stink Reporter</strong></a></div></header>` +
        `<main class="prose"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
        `<form method="POST" action="${escapeHtml(actionPath)}" style="margin-top:24px">` +
        `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
        `<button type="submit" style="background:${buttonBg};color:#FAF7F2;border:0;padding:12px 24px;border-radius:8px;font-family:inherit;font-size:16px;font-weight:600;cursor:pointer">${escapeHtml(buttonLabel)}</button>` +
        `</form></main></body></html>`;
}

module.exports = router;
