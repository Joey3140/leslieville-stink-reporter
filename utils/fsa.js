const fs = require('fs');
const path = require('path');
const { createChild } = require('./logger');

const log = createChild('fsa');

const ALLOWED_FSAS = ['M4L', 'M4M', 'M4J', 'M4K', 'M4E', 'M4N', 'M4W', 'M5A', 'M4X', 'M4Y', 'M4S', 'M5N', 'M1N'];
const FSA_REGEX = /^M[0-9][A-Z]$/;

let geojsonCache = null;
function loadGeojson() {
    if (geojsonCache) return geojsonCache;
    const file = path.join(__dirname, '..', 'public', 'data', 'fsa-leslieville.geojson');
    try {
        const raw = fs.readFileSync(file, 'utf8');
        geojsonCache = JSON.parse(raw);
        return geojsonCache;
    } catch (err) {
        log.warn({ err: err.message }, 'FSA GeoJSON not available — point-in-polygon disabled');
        return null;
    }
}

// Ray-casting point-in-polygon. Handles MultiPolygon by testing each polygon.
function pointInPolygon(lng, lat, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function pointInGeometry(lng, lat, geometry) {
    if (geometry.type === 'Polygon') {
        const [outer, ...holes] = geometry.coordinates;
        if (!pointInPolygon(lng, lat, outer)) return false;
        return !holes.some((h) => pointInPolygon(lng, lat, h));
    }
    if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some((poly) => {
            const [outer, ...holes] = poly;
            if (!pointInPolygon(lng, lat, outer)) return false;
            return !holes.some((h) => pointInPolygon(lng, lat, h));
        });
    }
    return false;
}

// Returns FSA code if (lat,lng) is inside one of our polygons, else null.
function latLngToFsa(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const gj = loadGeojson();
    if (!gj || !Array.isArray(gj.features)) return null;
    for (const feature of gj.features) {
        const props = feature.properties || {};
        const code = props.CFSAUID || props.FSA || props.fsa || props.cfsauid;
        if (!code || !ALLOWED_FSAS.includes(code)) continue;
        if (pointInGeometry(lng, lat, feature.geometry)) return code;
    }
    return null;
}

function isAllowedFsa(fsa) {
    return typeof fsa === 'string' && ALLOWED_FSAS.includes(fsa.toUpperCase());
}

function isValidFsaShape(fsa) {
    return typeof fsa === 'string' && FSA_REGEX.test(fsa.toUpperCase());
}

// ── Intersection allow-list ────────────────────────────────────────────
// Loaded once at module init from public/data/intersections.json.
let intersectionsCache = null;
function loadIntersections() {
    if (intersectionsCache) return intersectionsCache;
    const file = path.join(__dirname, '..', 'public', 'data', 'intersections.json');
    const empty = { list: [], names: new Set(), byFsa: {}, fsaByName: {}, coordsByName: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(raw.intersections) ? raw.intersections : [];
        const names = new Set();
        const byFsa = {};
        const fsaByName = {};
        const coordsByName = {};
        list.forEach((x) => {
            if (!x || typeof x.name !== 'string' || typeof x.fsa !== 'string') return;
            if (!ALLOWED_FSAS.includes(x.fsa)) return;
            names.add(x.name);
            fsaByName[x.name] = x.fsa;
            (byFsa[x.fsa] = byFsa[x.fsa] || []).push(x.name);
            if (Number.isFinite(x.lat) && Number.isFinite(x.lng)) {
                coordsByName[x.name] = { lat: x.lat, lng: x.lng };
            }
        });
        intersectionsCache = { list, names, byFsa, fsaByName, coordsByName };
        return intersectionsCache;
    } catch (err) {
        log.warn({ err: err.message }, 'intersections.json not loaded — intersection feature disabled');
        intersectionsCache = empty;
        return empty;
    }
}

function isAllowedIntersection(name) {
    return loadIntersections().names.has(name);
}

function fsaForIntersection(name) {
    return loadIntersections().fsaByName[name] || null;
}

function latLngForIntersection(name) {
    return loadIntersections().coordsByName[name] || null;
}

module.exports = {
    ALLOWED_FSAS, latLngToFsa, isAllowedFsa, isValidFsaShape, loadGeojson,
    loadIntersections, isAllowedIntersection, fsaForIntersection, latLngForIntersection,
};
