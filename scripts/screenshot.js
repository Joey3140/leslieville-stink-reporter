#!/usr/bin/env node
// Headless screenshot script — drives the system Chrome via puppeteer-core.
// Usage: node scripts/screenshot.js
//
// Captures the four pages at 1280x900 (desktop) and 390x844 (mobile),
// saves PNGs into /tmp/lsv-shots/.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.LSV_BASE_URL || 'http://localhost:3300';
const OUT = '/tmp/lsv-shots';
const PAGES = ['/', '/report', '/subscribe', '/about'];
const DESKTOP = { width: 1280, height: 900 };
const MOBILE  = { width: 390,  height: 844 };

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--no-sandbox', '--hide-scrollbars'],
        defaultViewport: DESKTOP,
    });

    for (const route of PAGES) {
        const safe = route === '/' ? 'landing' : route.replace(/\//g, '');
        for (const [variant, vp] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
            const page = await browser.newPage();
            await page.setViewport(vp);
            await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle0', timeout: 12000 }).catch((e) => {
                console.warn(`networkidle0 timeout for ${route} ${variant} — taking shot anyway:`, e.message);
            });
            await new Promise((r) => setTimeout(r, 800));
            // Above-the-fold (viewport only) so we can read details clearly.
            const file = path.join(OUT, `${safe}-${variant}-fold.png`);
            await page.screenshot({ path: file, fullPage: false });
            // Full-page archived too.
            const fullFile = path.join(OUT, `${safe}-${variant}-full.png`);
            await page.screenshot({ path: fullFile, fullPage: true });
            console.log(`wrote ${file} & ${fullFile}`);
            await page.close();
        }
    }
    await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
