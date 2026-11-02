// Local preview of the redesigned site. Serves public/ with the production CSP and
// answers /api from a captured snapshot, so nothing touches the live site.
//
//   node art/raccoon/preview-server.js          then open http://localhost:4173/raccoon-lab
//
// Add ?mood=1..5 to the dashboard to see any state on the real page.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const pub = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 4173;
const fixturePath = path.join(__dirname, 'out', 'fixtures.json');
const fixtures = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
const POSITIVE = { 1: 0, 2: 2, 3: 7, 4: 18, 5: 45 };

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.geojson': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const csp = [...src.matchAll(/^\s+'([a-z-]+-src)':\s*\[(.*?)\],?\s*$/gm)]
    .map((m) => `${m[1]} ${m[2].split(',').map((v) => v.trim().slice(1, -1)).join(' ')}`)
    .join('; ');

function api(req, res, url) {
    const key = url.pathname + url.search;
    const hit = fixtures[key] || Object.entries(fixtures).find(([k]) => k.split('?')[0] === url.pathname)?.[1];
    let body = hit ? hit.body : '{}';
    const mood = Number(/previewMood=(\d)/.exec(req.headers.cookie || '')?.[1]);
    if (url.pathname === '/api/reports/stats') {
        const s = JSON.parse(body);
        // Saved copies can predate last24h.
        s.last24h ??= s.today;
        s.clearCheckInsLast24h ??= s.clearCheckInsToday;
        if (mood >= 1 && mood <= 5) {
            s.clearCheckInsLast24h = 0;
            s.last24h = POSITIVE[mood];
        }
        body = JSON.stringify(s);
    }
    res.writeHead(hit ? hit.status : 200, { 'content-type': 'application/json' });
    res.end(body);
}

function sendFile(req, res, file) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404);
            return res.end('Not found');
        }
        const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-security-policy': csp, 'referrer-policy': 'no-referrer' };
        // The site sends no referrer, so ?mood= reaches the stats call through a cookie.
        if (path.basename(file) === 'index.html') {
            const m = new URL(req.url, 'http://localhost').searchParams.get('mood');
            headers['set-cookie'] = `previewMood=${/^[1-5]$/.test(m) ? m : 0}; Path=/; SameSite=Lax`;
        }
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : st.size - 1;
            res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
            return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...headers, 'content-length': st.size });
        fs.createReadStream(file).pipe(res);
    });
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    if (url.pathname === '/raccoon-lab') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return fs.createReadStream(path.join(__dirname, 'lab.html')).pipe(res);
    }
    const pages = { '/': 'index.html', '/report': 'report.html', '/subscribe': 'subscribe.html', '/about': 'about.html', '/unsubscribe': 'unsubscribe.html' };
    const rel = pages[url.pathname] || decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(pub, rel);
    if (!file.startsWith(pub)) {
        res.writeHead(403);
        return res.end();
    }
    sendFile(req, res, file);
}).listen(PORT, '127.0.0.1', () => console.log(`Preview: http://localhost:${PORT}/raccoon-lab`));
