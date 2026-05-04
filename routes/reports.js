const express = require('express');
const { requireDb, COLLECTIONS, FieldValue } = require('../utils/firestore');
const { hmacIp, getClientIp, deterministicJitter } = require('../utils/hash');
const { latLngToFsa, isAllowedFsa, fsaForIntersection, latLngForIntersection } = require('../utils/fsa');
const { validate, validateQuery, schemas, ODOUR_TYPES, SEVERITY_VALUES } = require('../middleware/validate');
const { createRateLimit } = require('../middleware/rate-limit');
const { turnstileMiddleware } = require('../middleware/turnstile');
const { createChild } = require('../utils/logger');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();
const log = createChild('routes.reports');

const PII_PATTERNS = [
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,                                   // email
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,        // phone
    /\b\d{1,5}\s+[A-Za-z][A-Za-z\s]{2,40}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct)\b/i, // street
];
function flagPii(text) {
    if (!text) return [];
    return PII_PATTERNS.map((re, i) => (re.test(text) ? ['email', 'phone', 'address'][i] : null)).filter(Boolean);
}

// UTC dayKey. Note: stats endpoints and the raccoon meter expose this as "today" —
// for a Toronto resident, "today" rolls over at 7-8 PM local. Acceptable for v1
// because daily counts are aggregations, not time-sensitive UX.
function dayKey(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

const REPORT_RETENTION_DAYS = 30;

const submitLimiter = createRateLimit({ max: 10, windowMs: 60 * 60 * 1000, bucket: 'submit', message: 'Too many reports from this IP, please try again later' });

router.post('/',
    submitLimiter,
    turnstileMiddleware(),
    validate(schemas.submitReport),
    asyncHandler(async (req, res) => {
        if (process.env.SUBMISSIONS_PAUSED === 'true') {
            return res.status(503).json({ error: 'Reports are temporarily paused for maintenance.' });
        }

        const db = requireDb();
        const data = req.validated;

        const ip = getClientIp(req);
        const ipHash = hmacIp(ip);
        const now = new Date();

        // If precise location given, derive the FSA server-side and require it match an allowed area.
        // If GPS lands outside our watched FSAs, reject — don't silently trust the user-claimed FSA
        // (otherwise a downtown user could tag a Leslieville report with their downtown coords).
        let derivedFsa = null;
        if (data.approxLat != null && data.approxLng != null) {
            derivedFsa = latLngToFsa(data.approxLat, data.approxLng);
            if (!derivedFsa) {
                return res.status(400).json({
                    error: "Your shared location isn't in any watched FSA. Submit again without sharing location, or pick the nearest area manually.",
                });
            }
            if (derivedFsa !== data.fsa) {
                log.info({ claimed: data.fsa, derived: derivedFsa }, 'fsa mismatch — using derived');
            }
        }
        const fsa = derivedFsa || data.fsa;
        if (!isAllowedFsa(fsa)) {
            return res.status(400).json({ error: 'Invalid FSA' });
        }

        // If user picked an intersection, it must belong to the resolved FSA.
        // Defensive: prevents a Beaches user from pinning a Leslieville report.
        if (data.intersection) {
            const expectedFsa = fsaForIntersection(data.intersection);
            if (expectedFsa && expectedFsa !== fsa) {
                return res.status(400).json({
                    error: `Intersection "${data.intersection}" is in ${expectedFsa}, not ${fsa}.`,
                });
            }
        }

        // Shadow-throttle: dedup on (clientId AND ipHash) — both must match an existing report
        // in the last 30 min. Requiring ipHash to match too prevents an attacker on a different
        // network from spoofing a victim's clientId to silence them. Composite index needed:
        // (clientId Asc, ipHash Asc, createdAt Asc).
        const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
        const recent = await db.collection(COLLECTIONS.reports)
            .where('clientId', '==', data.clientId)
            .where('ipHash', '==', ipHash)
            .where('createdAt', '>=', thirtyMinAgo)
            .limit(1)
            .get();
        if (!recent.empty) {
            log.info({ clientIdShort: data.clientId.slice(0, 8) }, 'shadow-throttled (dedup)');
            return res.status(200).json({ ok: true, deduped: true });
        }

        const reviewFlags = flagPii(data.description);
        const status = reviewFlags.length > 0 ? 'pending-review' : 'active';
        // expiresAt drives Firestore TTL. Set TTL policy on `reports.expiresAt` in console.
        // After 30d the entire report is auto-deleted (drops ipHash, userAgent, description).
        const expiresAt = new Date(now.getTime() + REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

        // We deliberately do NOT store userAgent — it's never read by any endpoint
        // and would add fingerprinting risk for no benefit. ipHash is enough for
        // rate-limiting; clientId is enough for dedup + unique-reporter counts.
        const report = {
            createdAt: now,
            expiresAt,
            fsa,
            severity: data.severity,
            ipHash,
            clientId: data.clientId,
            status,
        };
        // odourType is optional — only stored when the reporter picked one.
        if (data.odourType) report.odourType = data.odourType;
        if (data.description) report.description = data.description;
        if (data.intersection) report.intersection = data.intersection;
        if (data.approxLat != null) {
            // Deterministic jitter: same reporter (ipHash) on same day always lands on the same
            // ~90m offset. Defeats triangulation-by-volume from the public dots endpoint.
            const jittered = deterministicJitter(data.approxLat, data.approxLng, ipHash, dayKey(now));
            report.approxLat = jittered.lat;
            report.approxLng = jittered.lng;
            report.userConsentedLocation = true;
            report.locationSource = 'gps';
        } else if (data.intersection) {
            // No GPS, but an allow-listed intersection — synthesize a coord from the
            // intersection's known lat/lng and jitter it the same way. Lets these
            // reports paint the 200m grid overlay just like GPS reports do, while
            // still respecting per-reporter quantization (~90m) so a single reporter's
            // 50 reports at "Queen & Pape" don't all stack on a pinpoint coord.
            // Privacy: Toronto major intersections are public landmarks, the
            // submission is already anonymous (no email/auth), and the jitter is
            // deterministic per-(ipHash,dayKey) so repeat submissions don't widen
            // the visible footprint.
            const ic = latLngForIntersection(data.intersection);
            if (ic) {
                const jittered = deterministicJitter(ic.lat, ic.lng, ipHash, dayKey(now));
                report.approxLat = jittered.lat;
                report.approxLng = jittered.lng;
                report.userConsentedLocation = true;
                report.locationSource = 'intersection';
            }
        }
        if (reviewFlags.length > 0) report.reviewFlags = reviewFlags;

        const reportRef = db.collection(COLLECTIONS.reports).doc();
        const counterId = `${fsa}_${dayKey(now)}`;
        const counterRef = db.collection(COLLECTIONS.dailyCounts).doc(counterId);

        try {
            await db.runTransaction(async (tx) => {
                tx.set(reportRef, report);
                if (status === 'active') {
                    // IMPORTANT: nest sub-counters under maps. set({merge:true}) does NOT
                    // expand dotted keys into nested paths (only update() does), so writing
                    // `'bySeverity.0': increment(1)` would store a literal flat field name.
                    // Heatmap/stats readers depend on `d.bySeverity['0']` resolving to a number.
                    const counterUpdate = {
                        fsa,
                        date: dayKey(now),
                        count: FieldValue.increment(1),
                        bySeverity: { [String(data.severity)]: FieldValue.increment(1) },
                        updatedAt: now,
                    };
                    // Only bump byType when an odourType was given; an undefined key
                    // would write a literal `byType.undefined` field.
                    if (data.odourType) {
                        counterUpdate.byType = { [data.odourType]: FieldValue.increment(1) };
                    }
                    tx.set(counterRef, counterUpdate, { merge: true });
                }
            });
            log.info({ id: reportRef.id, fsa, severity: data.severity, status }, 'report submitted');
            res.json({ ok: true, id: reportRef.id, status });
        } catch (err) {
            log.error({ err }, 'failed to write report');
            res.status(500).json({ error: 'Failed to record report' });
        }
    })
);

const WINDOW_DAYS = { '24h': 1, '7d': 7, '30d': 30, all: 365 * 5 };

router.get('/heatmap',
    validateQuery(schemas.heatmapQuery),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const window = req.validatedQuery.window;
        const days = WINDOW_DAYS[window];

        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const cutoffKey = dayKey(cutoff);

        try {
            const snap = await db.collection(COLLECTIONS.dailyCounts)
                .where('date', '>=', cutoffKey)
                .get();
            // Heatmap polygons reflect *odour signal only* — exclude severity-0 ("all clear") check-ins
            // so a flood of clears can never repaint a polygon from red to cool.
            // Backwards-compat: legacy daily-counts may store the count as a flat 'bySeverity.0'
            // field instead of a nested map (pre-v1.2 writer used dotted keys with set+merge).
            const buckets = {};
            snap.forEach((doc) => {
                const d = doc.data();
                if (!d.fsa) return;
                const clearCount = (d.bySeverity && d.bySeverity['0']) || d['bySeverity.0'] || 0;
                const positive = (d.count || 0) - clearCount;
                buckets[d.fsa] = (buckets[d.fsa] || 0) + Math.max(0, positive);
            });
            res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=15');
            res.json({ window, generatedAt: new Date().toISOString(), counts: buckets });
        } catch (err) {
            log.error({ err }, 'heatmap query failed');
            res.status(500).json({ error: 'Failed to load heatmap' });
        }
    })
);

router.get('/recent',
    validateQuery(schemas.recentQuery),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const limit = req.validatedQuery.limit;
        try {
            const snap = await db.collection(COLLECTIONS.reports)
                .where('status', '==', 'active')
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get();
            const items = snap.docs.map((doc) => {
                const d = doc.data();
                return {
                    id: doc.id,
                    createdAt: d.createdAt?.toDate?.()?.toISOString?.() || new Date(d.createdAt).toISOString(),
                    fsa: d.fsa,
                    severity: d.severity,
                    odourType: d.odourType,
                    description: d.description ? d.description.slice(0, 280) : undefined,
                    intersection: d.intersection,
                };
            });
            res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=15');
            res.json({ items });
        } catch (err) {
            log.error({ err }, 'recent query failed');
            res.status(500).json({ error: 'Failed to load recent reports' });
        }
    })
);

router.get('/dots',
    validateQuery(schemas.dotsQuery),
    asyncHandler(async (req, res) => {
        const db = requireDb();
        const days = req.validatedQuery.window === '24h' ? 1 : 7;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        try {
            const snap = await db.collection(COLLECTIONS.reports)
                .where('status', '==', 'active')
                .where('createdAt', '>=', cutoff)
                .where('userConsentedLocation', '==', true)
                .limit(500)
                .get();
            const items = snap.docs.map((doc) => {
                const d = doc.data();
                return {
                    lat: d.approxLat,
                    lng: d.approxLng,
                    severity: d.severity,
                    odourType: d.odourType,
                    fsa: d.fsa,
                };
            }).filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng));
            res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
            res.json({ items });
        } catch (err) {
            log.error({ err }, 'dots query failed');
            res.status(500).json({ error: 'Failed to load dots' });
        }
    })
);

router.get('/stats', asyncHandler(async (req, res) => {
    const db = requireDb();
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    try {
        const sevenDaysAgoKey = dayKey(sevenDaysAgo);
        const startOfDayKey = dayKey(startOfDay);
        const [todaySnap, weekSnap, yearSnap, dailyCountsSnap] = await Promise.all([
            db.collection(COLLECTIONS.reports).where('status', '==', 'active').where('createdAt', '>=', startOfDay).count().get(),
            db.collection(COLLECTIONS.reports).where('status', '==', 'active').where('createdAt', '>=', sevenDaysAgo).count().get(),
            db.collection(COLLECTIONS.reports).where('status', '==', 'active').where('createdAt', '>=', yearStart).count().get(),
            // Read daily-counts for clear check-ins — avoids needing a new composite index
            // on reports(status, severity, createdAt). Counter updates are transactional with
            // the report write so day-of values match.
            db.collection(COLLECTIONS.dailyCounts).where('date', '>=', sevenDaysAgoKey).get(),
        ]);
        const reportersSnap = await db.collection(COLLECTIONS.reports)
            .where('status', '==', 'active')
            .where('createdAt', '>=', sevenDaysAgo)
            .select('clientId')
            .get();
        const uniqueReporters = new Set(reportersSnap.docs.map((d) => d.data().clientId)).size;

        let clearCheckInsThisWeek = 0;
        let clearCheckInsToday = 0;
        dailyCountsSnap.forEach((doc) => {
            const d = doc.data();
            // Tolerate both nested map (post-v1.2) and legacy flat 'bySeverity.0' field.
            const c0 = (d.bySeverity && d.bySeverity['0']) || d['bySeverity.0'] || 0;
            clearCheckInsThisWeek += c0;
            if (d.date && d.date >= startOfDayKey) clearCheckInsToday += c0;
        });

        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=15');
        res.json({
            today: todaySnap.data().count,
            thisWeek: weekSnap.data().count,
            thisYear: yearSnap.data().count,
            uniqueReportersThisWeek: uniqueReporters,
            clearCheckInsToday,
            clearCheckInsThisWeek,
            generatedAt: new Date().toISOString(),
        });
    } catch (err) {
        log.error({ err }, 'stats query failed');
        res.status(500).json({ error: 'Failed to load stats' });
    }
}));

router.get('/meta', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
        odourTypes: ODOUR_TYPES,
        severities: SEVERITY_VALUES,
        severityLabels: { 0: 'All clear', 1: 'Faint', 3: 'Strong', 5: 'Overwhelming' },
    });
});

module.exports = router;
