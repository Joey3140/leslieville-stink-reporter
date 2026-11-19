// The production guard that hides the preview pages. It must match the path the way
// express.static resolves it (decoded + normalised); a raw-path match let
// /%70review-nav.html through until 2026-11-19. `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPreviewPath } = require('../middleware/preview-guard');

test('blocks every spelling of the preview pages', () => {
    for (const p of [
        '/preview', '/preview/', '/preview-nav', '/preview-nav.html', '/preview/index.html', '/preview/x/y.png',
        '/%70review-nav.html', '/%70%72%65view', '/PREVIEW-NAV.HTML', '/Preview/', '/x/../preview-nav.html',
        '//preview-nav.html', '/./preview/a.html', '/preview-nav.html/', '/%2e/preview-nav.html', '/bad%zzescape',
    ]) {
        assert.equal(isPreviewPath(p), true, p);
    }
});

test('lets real pages through', () => {
    for (const p of ['/', '/report', '/about', '/subscribe', '/js/app.js', '/previewer', '/data/intersections.json', '/preview-navigation']) {
        assert.equal(isPreviewPath(p), false, p);
    }
});
