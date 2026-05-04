#!/usr/bin/env node
// One-off: geocode each intersection in public/data/intersections.json via
// Nominatim (free, no key) and write back lat/lng. Validates each result
// against the FSA polygon it claims to belong to; on mismatch, falls back to
// the polygon centroid so a bogus geocode never escapes the FSA boundary.
//
// Run: node scripts/geocode-intersections.js
// Nominatim usage policy: 1 req/sec, descriptive User-Agent. We sleep 1.2s
// between requests to be safe.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTERSECTIONS_PATH = path.join(ROOT, 'public', 'data', 'intersections.json');
const FSA_PATH = path.join(ROOT, 'public', 'data', 'fsa-leslieville.geojson');

const SLEEP_MS = 1200;
const UA = 'leslieville-stink-reporter/1.0 (https://github.com/Joey3140/leslieville-stink-reporter)';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const hit = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi);
        if (hit) inside = !inside;
    }
    return inside;
}
function pointInGeometry(lng, lat, geom) {
    if (geom.type === 'Polygon') {
        const [outer, ...holes] = geom.coordinates;
        if (!pointInRing(lng, lat, outer)) return false;
        return !holes.some((h) => pointInRing(lng, lat, h));
    }
    if (geom.type === 'MultiPolygon') {
        return geom.coordinates.some(([outer, ...holes]) => {
            if (!pointInRing(lng, lat, outer)) return false;
            return !holes.some((h) => pointInRing(lng, lat, h));
        });
    }
    return false;
}
function fsaCentroid(geom) {
    const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
    let sx = 0, sy = 0;
    ring.forEach(([x, y]) => { sx += x; sy += y; });
    return { lat: sy / ring.length, lng: sx / ring.length };
}

// Map our shorthand street names to Nominatim-friendly full names. Without
// this expansion, queries like "Queen & Coxwell" get matched to nodes on
// Queen alone and end up returning the same coord for unrelated cross-streets.
const STREET_EXPANSIONS = {
    Queen: 'Queen Street East', Dundas: 'Dundas Street East', Gerrard: 'Gerrard Street East',
    Eastern: 'Eastern Avenue', King: 'King Street East', Front: 'Front Street East',
    'Lake Shore': 'Lake Shore Boulevard East', Danforth: 'Danforth Avenue',
    Cosburn: 'Cosburn Avenue', Kingston: 'Kingston Road',
    Carlaw: 'Carlaw Avenue', Logan: 'Logan Avenue', Pape: 'Pape Avenue',
    Jones: 'Jones Avenue', Greenwood: 'Greenwood Avenue', Coxwell: 'Coxwell Avenue',
    Woodbine: 'Woodbine Avenue', Leslie: 'Leslie Street',
    Lee: 'Lee Avenue', Beech: 'Beech Avenue', Balsam: 'Balsam Avenue',
    'Glen Manor': 'Glen Manor Drive',
    Donlands: 'Donlands Avenue', Broadview: 'Broadview Avenue',
    Parliament: 'Parliament Street', River: 'River Street',
    'Victoria Park': 'Victoria Park Avenue', Warden: 'Warden Avenue',
    Birchmount: 'Birchmount Road',
};
function expand(short) {
    return STREET_EXPANSIONS[short] || short;
}

async function geocodeOnce(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=ca`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const lat = parseFloat(arr[0].lat);
    const lng = parseFloat(arr[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

async function geocode(name) {
    // "Queen & Carlaw" → ["Queen Street East", "Carlaw Avenue"]
    const parts = name.split('&').map((s) => s.trim());
    if (parts.length !== 2) return null;
    const [a, b] = parts.map(expand);
    // Try a few phrasings — Nominatim's tolerance for intersection queries is
    // erratic. Stop at the first result that returns a coord.
    const phrasings = [
        `${a} and ${b}, Toronto, Ontario, Canada`,
        `${a} & ${b}, Toronto, Ontario, Canada`,
        `${a} at ${b}, Toronto, Ontario, Canada`,
    ];
    for (const q of phrasings) {
        try {
            const g = await geocodeOnce(q);
            if (g) return g;
        } catch (_e) { /* try next */ }
        await sleep(SLEEP_MS);
    }
    return null;
}

(async () => {
    const intersections = JSON.parse(fs.readFileSync(INTERSECTIONS_PATH, 'utf8'));
    const fsaGeo = JSON.parse(fs.readFileSync(FSA_PATH, 'utf8'));
    const fsaByCode = {};
    for (const f of fsaGeo.features || []) fsaByCode[f.properties.CFSAUID] = f;

    // Pass `--reset` to wipe existing coords and re-geocode from scratch.
    // Otherwise, intersections that already have lat/lng are kept as-is and
    // only the dedup pass runs at the end.
    const reset = process.argv.includes('--reset');
    if (reset) {
        intersections.intersections.forEach((ix) => { delete ix.lat; delete ix.lng; });
    }

    let ok = 0, fallback = 0, fail = 0;
    for (const ix of intersections.intersections) {
        const fsaFeat = fsaByCode[ix.fsa];
        if (!fsaFeat) {
            console.error(`! ${ix.name} — FSA ${ix.fsa} not in geojson; skipping`);
            ix.lat = null;
            ix.lng = null;
            fail++;
            continue;
        }
        if (Number.isFinite(ix.lat) && Number.isFinite(ix.lng)) {
            ok++;
            continue;
        }
        try {
            const g = await geocode(ix.name);
            if (g && pointInGeometry(g.lng, g.lat, fsaFeat.geometry)) {
                ix.lat = +g.lat.toFixed(5);
                ix.lng = +g.lng.toFixed(5);
                console.log(`✓ ${ix.name} (${ix.fsa}) → ${ix.lat}, ${ix.lng}`);
                ok++;
            } else {
                const c = fsaCentroid(fsaFeat.geometry);
                ix.lat = +c.lat.toFixed(5);
                ix.lng = +c.lng.toFixed(5);
                const reason = g ? 'outside FSA' : 'no result';
                console.log(`~ ${ix.name} (${ix.fsa}) → centroid ${ix.lat}, ${ix.lng} (${reason})`);
                fallback++;
            }
        } catch (err) {
            const c = fsaCentroid(fsaFeat.geometry);
            ix.lat = +c.lat.toFixed(5);
            ix.lng = +c.lng.toFixed(5);
            console.log(`! ${ix.name} (${ix.fsa}) → centroid ${ix.lat}, ${ix.lng} (err: ${err.message})`);
            fail++;
        }
        await sleep(SLEEP_MS);
    }

    // Dedup: if two intersections geocoded to the exact same coord (Nominatim
    // sometimes does this when the cross-street is ambiguous), force the
    // duplicates back to their FSA centroid so they don't claim each other's
    // positions on the heatmap.
    const seen = new Map();
    for (const ix of intersections.intersections) {
        if (!Number.isFinite(ix.lat) || !Number.isFinite(ix.lng)) continue;
        const key = `${ix.lat}|${ix.lng}`;
        if (seen.has(key)) {
            const c = fsaCentroid(fsaByCode[ix.fsa].geometry);
            ix.lat = +c.lat.toFixed(5);
            ix.lng = +c.lng.toFixed(5);
            console.log(`× ${ix.name} (${ix.fsa}) duplicated ${seen.get(key)} → reset to centroid`);
        } else {
            seen.set(key, ix.name);
        }
    }

    intersections.version = 3;
    intersections.comment = 'Curated allow-list of major intersections in the FSAs most affected by the Ashbridges Bay plant. lat/lng populated by scripts/geocode-intersections.js. Server applies deterministic per-reporter jitter when synthesizing approxLat/approxLng from these coords, so no individual report is geocoded back to a precise address.';
    fs.writeFileSync(INTERSECTIONS_PATH, JSON.stringify(intersections, null, 4) + '\n');
    console.log(`\nDone: ${ok} ok, ${fallback} fell back to centroid, ${fail} failed.`);
})();
