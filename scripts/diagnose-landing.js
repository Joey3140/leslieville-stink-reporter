#!/usr/bin/env node
const puppeteer = require('puppeteer-core');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        args: ['--no-sandbox'],
        defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    page.on('console', (m) => console.log('[browser]', m.type(), m.text()));
    page.on('pageerror', (e) => console.log('[error]', e.message));

    await page.goto('http://localhost:3300/', { waitUntil: 'networkidle0', timeout: 12000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const info = await page.evaluate(() => {
        const out = {};
        const ticker = document.getElementById('ticker');
        const tickerTrack = document.getElementById('tickerTrack');
        const lake = document.getElementById('lakeWave');
        const map = document.getElementById('map');
        const racc = document.getElementById('raccoonCard');
        const feed = document.getElementById('feedFrame');
        const stats = ['statToday','statWeek','statYear','statReporters'].map((id) => ({ id, val: document.getElementById(id)?.textContent }));

        const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
        const cs   = (el) => {
            if (!el) return null;
            const c = getComputedStyle(el);
            return { display: c.display, visibility: c.visibility, height: c.height, background: c.background, position: c.position, hidden: el.hidden };
        };

        out.ticker = { rect: rect(ticker), cs: cs(ticker), trackChildren: tickerTrack?.children.length, innerLength: ticker?.innerHTML.length };
        out.lake = { rect: rect(lake), childTag: lake?.firstElementChild?.tagName, innerLength: lake?.innerHTML.length };
        out.map = { rect: rect(map), hasLeaflet: !!map?.querySelector('.leaflet-pane') };
        out.raccoon = { rect: rect(racc), hasSvg: !!racc?.querySelector('svg') };
        out.feed = { rect: rect(feed), text: feed?.textContent?.slice(0, 100) };
        out.stats = stats;
        out.bodyHeight = document.body.scrollHeight;
        return out;
    });

    console.log(JSON.stringify(info, null, 2));
    await browser.close();
})();
