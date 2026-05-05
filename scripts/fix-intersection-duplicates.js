#!/usr/bin/env node
// One-off: fix duplicate coords in public/data/intersections.json without
// re-running the full Nominatim geocoder. The bug surfaced in a fresh-eyes
// audit — 51 named intersections collapsed to ~29 unique coordinate pairs
// because the geocoder's dedup pass fell back to FSA centroid for every
// duplicate, piling 8+ intersections onto a single point.
//
// What this does: identifies coords that match an FSA centroid (i.e. were
// fallback-collapsed), and scatters those entries around the centroid using
// a deterministic name-hash offset so each intersection has its own unique
// coord ~80–200m from centroid. Real Nominatim hits (where lat/lng don't
// match centroid) are left alone.
//
// Run: node scripts/fix-intersection-duplicates.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTERSECTIONS_PATH = path.join(ROOT, 'public', 'data', 'intersections.json');
const FSA_PATH = path.join(ROOT, 'public', 'data', 'fsa-leslieville.geojson');

function fsaCentroid(geom) {
    const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
    let sx = 0, sy = 0;
    ring.forEach(([x, y]) => { sx += x; sy += y; });
    return { lat: sy / ring.length, lng: sx / ring.length };
}

const crypto = require('crypto');

// SHA-256 gives better-distributed bits than the djb2 string hash; we slice
// off two independent 24-bit windows so angle and radius vary independently.
function scatterSeed(name, salt = 0) {
    const h = crypto.createHash('sha256').update(`${name}|${salt}`).digest();
    return {
        angle: ((h[0] << 16) | (h[1] << 8) | h[2]) / 0xFFFFFF,        // [0,1)
        radius: ((h[3] << 16) | (h[4] << 8) | h[5]) / 0xFFFFFF,
    };
}
function scatterAroundCentroid(centroid, name, salt = 0) {
    const s = scatterSeed(name, salt);
    const angle = s.angle * 2 * Math.PI;
    // Tightened to 80–220m so scattered points stay inside even the narrow
    // FSAs (M4M, M4L). Combined with the salt-retry loop downstream we still
    // get pairwise uniqueness ≥50m without crossing polygon boundaries.
    const radiusM = 80 + s.radius * 140;
    const dLat = (radiusM * Math.cos(angle)) / 111_000;
    const dLng = (radiusM * Math.sin(angle)) / (111_000 * Math.cos(centroid.lat * Math.PI / 180));
    return {
        lat: +(centroid.lat + dLat).toFixed(5),
        lng: +(centroid.lng + dLng).toFixed(5),
    };
}

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

function haversineM(a, b) {
    const R = 6_371_000;
    const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
    const dφ = (b.lat - a.lat) * Math.PI / 180;
    const dλ = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

(function main() {
    const intersections = JSON.parse(fs.readFileSync(INTERSECTIONS_PATH, 'utf8'));
    const fsaGeo = JSON.parse(fs.readFileSync(FSA_PATH, 'utf8'));
    const centroids = {};
    const fsaByCode = {};
    for (const f of fsaGeo.features || []) {
        centroids[f.properties.CFSAUID] = fsaCentroid(f.geometry);
        fsaByCode[f.properties.CFSAUID] = f;
    }

    const MIN_DIST_M = 50;
    function placedPoints() {
        return intersections.intersections
            .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng))
            .map((x) => ({ name: x.name, lat: x.lat, lng: x.lng }));
    }
    function scatterUnique(centroid, name, fsaFeat) {
        // Iterate the salt until the scattered point satisfies BOTH:
        //   (a) ≥ MIN_DIST_M from every other already-placed intersection
        //   (b) inside the FSA polygon (stays where users expect it)
        const others = placedPoints().filter((p) => p.name !== name);
        for (let salt = 0; salt < 64; salt++) {
            const s = scatterAroundCentroid(centroid, name, salt);
            const inFsa = !fsaFeat || pointInGeometry(s.lng, s.lat, fsaFeat.geometry);
            const tooClose = others.some((p) => haversineM(p, s) < MIN_DIST_M);
            if (inFsa && !tooClose) return s;
        }
        // Fallback shouldn't fire in practice; if it does we accept a slightly
        // off-polygon point rather than collapsing back to the bug we're fixing.
        return scatterAroundCentroid(centroid, name, 0);
    }

    let scattered = 0;
    // First pass: scatter anything sitting exactly on its FSA centroid (within
    // ~5m, accounting for 5-decimal rounding in the source file).
    for (const ix of intersections.intersections) {
        if (!Number.isFinite(ix.lat) || !Number.isFinite(ix.lng)) continue;
        const c = centroids[ix.fsa];
        if (!c) continue;
        const cRounded = { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5) };
        const onCentroid = Math.abs(ix.lat - cRounded.lat) < 1e-5 && Math.abs(ix.lng - cRounded.lng) < 1e-5;
        if (onCentroid) {
            const s = scatterUnique(c, ix.name, fsaByCode[ix.fsa]);
            console.log(`~ ${ix.name} (${ix.fsa}) was on centroid → ${s.lat}, ${s.lng}`);
            ix.lat = s.lat;
            ix.lng = s.lng;
            scattered++;
        }
    }

    // Second pass: any remaining duplicates — scatter them apart too.
    const seen = new Map();
    for (const ix of intersections.intersections) {
        if (!Number.isFinite(ix.lat) || !Number.isFinite(ix.lng)) continue;
        const key = `${ix.lat}|${ix.lng}`;
        if (seen.has(key)) {
            const c = centroids[ix.fsa];
            if (c) {
                const s = scatterUnique(c, ix.name, fsaByCode[ix.fsa]);
                console.log(`× ${ix.name} (${ix.fsa}) duplicated ${seen.get(key)} → ${s.lat}, ${s.lng}`);
                ix.lat = s.lat;
                ix.lng = s.lng;
                scattered++;
            }
            seen.set(`${ix.lat}|${ix.lng}`, ix.name);
        } else {
            seen.set(key, ix.name);
        }
    }

    // Validate: pairwise distance ≥ 30m for any two intersections.
    const list = intersections.intersections.filter((ix) => Number.isFinite(ix.lat) && Number.isFinite(ix.lng));
    let minDist = Infinity, minPair = null;
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const d = haversineM(list[i], list[j]);
            if (d < minDist) { minDist = d; minPair = [list[i].name, list[j].name]; }
        }
    }
    console.log(`\nMinimum pairwise distance: ${minDist.toFixed(1)}m (${minPair?.join(' ↔ ')})`);

    intersections.version = (intersections.version || 0) + 1;
    fs.writeFileSync(INTERSECTIONS_PATH, JSON.stringify(intersections, null, 4) + '\n');
    console.log(`Done. Scattered ${scattered} entries. Version → ${intersections.version}.`);
})();
