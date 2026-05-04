// Pure helpers for the weather route. Kept out of routes/weather.js so they can
// be unit-tested without spinning up Express.

// 8-point compass: N at 0°, NE 45°, ..., NW 315°. Each sector is 45° wide.
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function degreesToCardinal(deg) {
    if (!Number.isFinite(deg)) return 'N';
    const normalized = ((deg % 360) + 360) % 360;
    const idx = Math.round(normalized / 45) % 8;
    return CARDINALS[idx];
}

// "wind from" angle → "wind to" angle (180° opposite).
function oppositeCardinal(deg) {
    if (!Number.isFinite(deg)) return 'S';
    return degreesToCardinal(deg + 180);
}

module.exports = { degreesToCardinal, oppositeCardinal };
