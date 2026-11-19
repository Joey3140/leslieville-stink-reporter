// Hide the design-iteration preview pages (public/preview/, public/preview-nav.html) in
// production. They hold no data, but they ship dev scaffolding to anyone poking around.
//
// Match on the DECODED, normalised path, the way express.static resolves it. The old guard
// matched the raw path, so /%70review-nav.html (or /x/../preview-nav.html) slipped past it and
// express.static served the page anyway (found by the 2026-11-19 site review).
const path = require('path');

const PREVIEW = /^\/preview(?:-nav)?(?:\.html)?$|^\/preview\//;

function isPreviewPath(rawPath) {
    let p;
    try {
        p = decodeURIComponent(rawPath);
    } catch {
        return true; // malformed %-escape: refuse rather than guess
    }
    p = path.posix.normalize(p.replace(/\\/g, '/')).toLowerCase();
    return PREVIEW.test(p) || PREVIEW.test(p.replace(/\/+$/, ''));
}

function previewGuard(notFoundFile) {
    return (req, res, next) => (isPreviewPath(req.path) ? res.status(404).sendFile(notFoundFile) : next());
}

module.exports = { isPreviewPath, previewGuard };
