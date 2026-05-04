const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { createChild } = require('../utils/logger');
const { degreesToCardinal } = require('../utils/weather');

const router = express.Router();
const log = createChild('routes.weather');

// Ashbridges Bay WTP — the smell source. Wind here is what determines which FSAs
// catch the plume on a given day; we don't ask the client for their location.
const SOURCE_LAT = 43.660;
const SOURCE_LON = -79.314;

const OWM_URL = `https://api.openweathermap.org/data/2.5/weather?lat=${SOURCE_LAT}&lon=${SOURCE_LON}&units=metric`;
const FETCH_TIMEOUT_MS = 5000;

router.get('/current', asyncHandler(async (req, res) => {
    const apiKey = process.env.OPENWEATHERMAP_API_KEY;
    if (!apiKey) {
        // Don't 500 on missing config — the widget is optional. 503 lets the client hide.
        return res.status(503).json({ error: 'weather not configured' });
    }

    const url = `${OWM_URL}&appid=${encodeURIComponent(apiKey)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const upstream = await fetch(url, { signal: ctrl.signal });
        if (!upstream.ok) {
            log.warn({ status: upstream.status }, 'OWM upstream non-ok');
            return res.status(503).json({ error: 'weather upstream unavailable' });
        }
        const data = await upstream.json();
        const speedMs = Number(data.wind?.speed);
        const direction = Number(data.wind?.deg);
        const tempC = Number(data.main?.temp);
        const conditions = data.weather?.[0]?.description || '';
        const observedAt = Number.isFinite(data.dt)
            ? new Date(data.dt * 1000).toISOString()
            : new Date().toISOString();

        const speedKmh = Number.isFinite(speedMs) ? Math.round(speedMs * 3.6 * 10) / 10 : null;
        const cardinal = Number.isFinite(direction) ? degreesToCardinal(direction) : null;

        // 10-min edge cache, stale-while-revalidate 30 min. Keeps ≤6 OWM calls/hour
        // worst-case across all clients, well under the free-tier 60/min limit.
        res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
        res.json({
            wind: { speedKmh, direction: Number.isFinite(direction) ? direction : null, cardinal },
            tempC: Number.isFinite(tempC) ? tempC : null,
            conditions,
            observedAt,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            log.warn('OWM upstream timed out');
        } else {
            log.error({ err }, 'OWM fetch failed');
        }
        res.status(503).json({ error: 'weather upstream unavailable' });
    } finally {
        clearTimeout(timer);
    }
}));

module.exports = router;
