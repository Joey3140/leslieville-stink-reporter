const express = require('express');
const { requireDb, COLLECTIONS, FieldValue } = require('../utils/firestore');
const { sendBatch } = require('../utils/email');
const { cronAuth } = require('../middleware/cron-auth');
const { asyncHandler } = require('../utils/async-handler');
const { createChild } = require('../utils/logger');

const router = express.Router();
const log = createChild('routes.alerts');

const SEV_LABEL = { 1: 'Faint', 2: 'Mild', 3: 'Strong', 4: 'Severe', 5: 'Overwhelming' };
const THRESHOLD_REPORTS = Number(process.env.ALERT_THRESHOLD_REPORTS || 10);
const THRESHOLD_SEVERITY_AVG = Number(process.env.ALERT_THRESHOLD_SEVERITY_AVG || 3);
const COOLDOWN_HOURS = Number(process.env.ALERT_COOLDOWN_HOURS || 6);
const ALERT_DAILY_CAP = Number(process.env.ALERT_DAILY_CAP || 1000);   // circuit breaker

function severityLabel(avg) {
    const rounded = Math.round(avg);
    return SEV_LABEL[Math.max(1, Math.min(5, rounded))] || `${rounded}`;
}

router.post('/alert-check', cronAuth, asyncHandler(async (req, res) => {
    const db = requireDb();
    const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const cooldownCutoff = new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000);

    // Daily-cap circuit breaker. Tracks total alerts sent today; if exceeded, abort.
    const today = now.toISOString().slice(0, 10).replace(/-/g, '');
    const capRef = db.collection('alert-counters').doc(today);
    const capSnap = await capRef.get();
    const sentToday = capSnap.exists ? (capSnap.data().sentToday || 0) : 0;
    if (sentToday >= ALERT_DAILY_CAP) {
        log.error({ sentToday, cap: ALERT_DAILY_CAP }, 'daily alert cap exceeded — aborting');
        return res.status(200).json({ ok: true, aborted: 'daily-cap', sentToday });
    }

    // Find unique watched FSAs from active subscribers.
    const subsSnap = await db.collection(COLLECTIONS.subscribers).where('status', '==', 'active').get();
    const watchedFsas = new Set();
    const subsByFsa = {};
    subsSnap.docs.forEach((d) => {
        const data = d.data();
        (data.fsas || []).forEach((f) => {
            watchedFsas.add(f);
            (subsByFsa[f] = subsByFsa[f] || []).push({ id: d.id, ...data });
        });
    });

    if (watchedFsas.size === 0) {
        return res.json({ ok: true, message: 'no active subscribers — nothing to check' });
    }

    // For each watched FSA, count active reports in the last hour and average severity.
    // Doing per-FSA queries to leverage Firestore indexes; ~12 FSAs max so cheap.
    const triggered = [];
    for (const fsa of watchedFsas) {
        const snap = await db.collection(COLLECTIONS.reports)
            .where('status', '==', 'active')
            .where('fsa', '==', fsa)
            .where('createdAt', '>=', oneHourAgo)
            .select('severity', 'odourType').get();

        // Exclude severity-0 ("all clear") check-ins from threshold + average so a flood
        // of clears can't suppress a real alert (or fire a false one if the schema drifts).
        const positiveDocs = snap.docs.filter((d) => ((d.data().severity || 0) > 0));
        if (positiveDocs.length < THRESHOLD_REPORTS) continue;

        const odourCounts = {};
        let sevSum = 0;
        positiveDocs.forEach((d) => {
            const data = d.data();
            sevSum += data.severity || 0;
            odourCounts[data.odourType] = (odourCounts[data.odourType] || 0) + 1;
        });
        const avgSev = sevSum / positiveDocs.length;
        if (avgSev < THRESHOLD_SEVERITY_AVG) continue;

        // Cooldown check.
        const stateRef = db.collection(COLLECTIONS.alertState).doc(fsa);
        const stateSnap = await stateRef.get();
        const lastAlertedAt = stateSnap.exists ? stateSnap.data().lastAlertedAt?.toDate?.() : null;
        if (lastAlertedAt && lastAlertedAt > cooldownCutoff) {
            log.info({ fsa, lastAlertedAt }, 'alert skipped — within cooldown');
            continue;
        }

        const topOdour = Object.entries(odourCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'sewage';
        triggered.push({ fsa, count: positiveDocs.length, avgSev, topOdour, stateRef });
    }

    if (triggered.length === 0) {
        return res.json({ ok: true, checked: watchedFsas.size, triggered: 0 });
    }

    // Build email batch. Filter subscribers by FSA + threshold; dedup by email if subscriber
    // watches multiple triggered FSAs (combine into one digest email per address).
    const messagesByEmail = {};
    let queuedCount = 0;
    for (const t of triggered) {
        const eligible = (subsByFsa[t.fsa] || []).filter((s) => (s.thresholdSeverity || 3) <= t.avgSev);
        for (const sub of eligible) {
            if (sentToday + queuedCount >= ALERT_DAILY_CAP) break;
            // First trigger wins per email; future versions can digest multiple triggers.
            if (!messagesByEmail[sub.email]) {
                messagesByEmail[sub.email] = {
                    to: sub.email,
                    subject: `Stench alert — ${t.count} reports in ${t.fsa}`,
                    template: 'alert',
                    data: {
                        fsa: t.fsa,
                        count: t.count,
                        severityLabel: severityLabel(t.avgSev),
                        topOdour: t.topOdour,
                        baseUrl,
                        unsubscribeUrl: `${baseUrl}/api/subscribers/unsubscribe?token=${sub.unsubscribeToken}`,
                    },
                };
                queuedCount += 1;
            }
        }
    }

    const messages = Object.values(messagesByEmail);
    if (messages.length === 0) {
        return res.json({ ok: true, checked: watchedFsas.size, triggered: triggered.length, sent: 0 });
    }

    await sendBatch(messages);

    // Mark cooldown for each triggered FSA.
    await Promise.all(triggered.map((t) => t.stateRef.set({
        fsa: t.fsa,
        lastAlertedAt: now,
        lastAlertCount: t.count,
        lastAlertAvgSeverity: t.avgSev,
    }, { merge: true })));

    // Bump daily counter.
    await capRef.set({ sentToday: FieldValue.increment(messages.length), updatedAt: now }, { merge: true });

    log.info({ triggered: triggered.length, sent: messages.length, sentToday: sentToday + messages.length }, 'alerts dispatched');
    res.json({ ok: true, checked: watchedFsas.size, triggered: triggered.length, sent: messages.length });
}));

router.post('/prune-rate-limits', cronAuth, asyncHandler(async (req, res) => {
    const db = requireDb();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);   // 7-day grace beyond TTL
    const snap = await db.collection(COLLECTIONS.rateLimits).where('expiresAt', '<', cutoff).limit(500).get();
    if (snap.empty) return res.json({ ok: true, deleted: 0 });
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    log.info({ deleted: snap.size }, 'rate-limits pruned');
    res.json({ ok: true, deleted: snap.size });
}));

module.exports = router;
