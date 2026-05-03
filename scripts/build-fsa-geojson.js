#!/usr/bin/env node
// Build script — run once (or whenever boundaries change).
//
// Reads the StatCan-projected national FSA file from /tmp/lsv-fsa/all-canada.geojson
// (download URL below), filters to the ~12 FSAs ringing Ashbridges Bay, and reprojects
// from EPSG:3347 (StatCan Lambert) to WGS84 lat/lng for use in Leaflet.
//
// Source: https://raw.githubusercontent.com/sachijay/canada_maps/main/exported_files/forward_sortation_areas_simplified.geojson
//   curl -sL <url> -o /tmp/lsv-fsa/all-canada.geojson
//
// Usage: npm run build:fsa

const fs = require('fs');
const path = require('path');
const proj4 = require('proj4');

const ALLOWED_FSAS = ['M4L', 'M4M', 'M4J', 'M4K', 'M4E', 'M4N', 'M4W', 'M5A', 'M4X', 'M4Y', 'M4S', 'M5N'];

// EPSG:3347 — Statistics Canada Lambert
const SRC_PROJ = '+proj=lcc +lat_1=49 +lat_2=77 +lat_0=63.390675 +lon_0=-91.86666666666667 +x_0=6200000 +y_0=3000000 +ellps=GRS80 +units=m +no_defs +type=crs';
const DST_PROJ = 'EPSG:4326';
proj4.defs('EPSG:3347', SRC_PROJ);

function reprojectCoords(coords) {
    if (typeof coords[0] === 'number') {
        const [x, y] = coords;
        const [lng, lat] = proj4('EPSG:3347', DST_PROJ, [x, y]);
        return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
    }
    return coords.map(reprojectCoords);
}

function reprojectGeometry(geom) {
    return { type: geom.type, coordinates: reprojectCoords(geom.coordinates) };
}

const SRC_FILE = process.env.LSV_FSA_SRC || '/tmp/lsv-fsa/all-canada.geojson';
const OUT_FILE = path.join(__dirname, '..', 'public', 'data', 'fsa-leslieville.geojson');

if (!fs.existsSync(SRC_FILE)) {
    console.error(`Source file not found: ${SRC_FILE}`);
    console.error('Download with:');
    console.error('  mkdir -p /tmp/lsv-fsa && curl -sL https://raw.githubusercontent.com/sachijay/canada_maps/main/exported_files/forward_sortation_areas_simplified.geojson -o /tmp/lsv-fsa/all-canada.geojson');
    process.exit(1);
}

const src = JSON.parse(fs.readFileSync(SRC_FILE, 'utf8'));
const filtered = src.features.filter((f) => ALLOWED_FSAS.includes(f.properties?.CFSAUID));
console.log(`Found ${filtered.length} of ${ALLOWED_FSAS.length} target FSAs`);

const features = filtered.map((f) => ({
    type: 'Feature',
    properties: {
        CFSAUID: f.properties.CFSAUID,
        landAreaKm2: f.properties.LANDAREA,
    },
    geometry: reprojectGeometry(f.geometry),
}));

const out = { type: 'FeatureCollection', features };
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(out));
const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`Wrote ${OUT_FILE} (${sizeKb} KB, ${features.length} features)`);

const missing = ALLOWED_FSAS.filter((code) => !filtered.find((f) => f.properties.CFSAUID === code));
if (missing.length) console.warn('Missing FSAs (will be silently skipped on map):', missing);
