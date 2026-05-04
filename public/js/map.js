(function () {
    const { getJson, formatTimeAgo, SEV_LABEL, TYPE_LABEL } = window.LSV;
    const { renderRaccoon, severityToMood, autoBlinkRaccoon, renderLakeWave } = window.LSV;

    // ── Map setup ──────────────────────────────────────────────────────────
    // Centred over the Leslieville-Beaches axis; fits ~12 FSAs at zoom 12.
    const map = L.map('map', { zoomControl: true, scrollWheelZoom: false, attributionControl: true })
        .setView([43.668, -79.330], 12);

    // CARTO Positron is the cleanest match for the design's flat off-white aesthetic.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Heat ramp matches the Stink Tracker design system.
    const HEAT_RAMP = ['#F4EFE3', '#EFE3C2', '#E5D08A', '#E5A756', '#C97A35', '#B8552A', '#8E331C', '#6B1F12'];

    function colorFor(count) {
        if (!count) return HEAT_RAMP[0];
        if (count <= 2)  return HEAT_RAMP[1];
        if (count <= 5)  return HEAT_RAMP[2];
        if (count <= 10) return HEAT_RAMP[3];
        if (count <= 20) return HEAT_RAMP[4];
        if (count <= 40) return HEAT_RAMP[5];
        if (count <= 80) return HEAT_RAMP[6];
        return HEAT_RAMP[7];
    }

    let fsaLayer = null;
    const dotLayer = L.layerGroup().addTo(map);
    let activeWindow = '24h';
    let geojsonCache = null;

    async function loadGeojson() {
        if (geojsonCache) return geojsonCache;
        const r = await fetch('/data/fsa-leslieville.geojson');
        geojsonCache = await r.json();
        return geojsonCache;
    }

    function renderLegend() {
        const buckets = ['0', '1–2', '3–5', '6–10', '11–20', '21–40', '41–80', '80+'];
        const el = document.getElementById('mapLegend');
        const swatches = HEAT_RAMP.map((c) => `<span style="background:${c}"></span>`).join('');
        el.innerHTML = `<span>Fewer</span><span class="legend-bar">${swatches}</span><span>More</span>`;
    }

    function styleForFeature(counts) {
        return (feature) => {
            const fsa = feature.properties.CFSAUID;
            const c = counts[fsa] || 0;
            return {
                fillColor: colorFor(c),
                fillOpacity: 0.72,
                weight: 0.8,
                color: '#1B1B1B',
                opacity: 0.4,
            };
        };
    }

    function setupTooltipBehavior(feature, layer, count) {
        const fsa = feature.properties.CFSAUID;
        const tip = document.getElementById('fsaTooltip');
        const showTip = () => {
            tip.innerHTML = `<strong>${escapeHtml(fsa)}</strong><div class="sub">${count} report${count === 1 ? '' : 's'} · ${escapeHtml(activeWindow)}</div>`;
            tip.classList.add('show');
            layer.setStyle({ weight: 2, opacity: 1 });
        };
        const hideTip = () => {
            tip.classList.remove('show');
            layer.setStyle({ weight: 0.8, opacity: 0.4 });
        };
        layer.on('mouseover', showTip);
        layer.on('mouseout', hideTip);
        layer.on('click', showTip);
    }

    async function refreshHeatmap(geojson) {
        try {
            const { counts } = await getJson(`/api/reports/heatmap?window=${activeWindow}`);
            if (fsaLayer) fsaLayer.remove();
            fsaLayer = L.geoJSON(geojson, {
                style: styleForFeature(counts),
                onEachFeature: (feature, layer) => {
                    const fsa = feature.properties.CFSAUID;
                    setupTooltipBehavior(feature, layer, counts[fsa] || 0);
                },
            }).addTo(map);
        } catch (err) {
            console.error('heatmap failed', err);
        }
    }

    async function refreshDots() {
        if (activeWindow !== '24h' && activeWindow !== '7d') {
            dotLayer.clearLayers();
            return;
        }
        try {
            const { items } = await getJson(`/api/reports/dots?window=${activeWindow}`);
            dotLayer.clearLayers();
            items.forEach((d) => {
                const radius = 3 + (d.severity * 0.6);
                const opacity = 0.45 + (d.severity * 0.1);
                L.circleMarker([d.lat, d.lng], {
                    radius,
                    color: '#1B1B1B',
                    weight: 0.5,
                    fillColor: '#DA291C',
                    fillOpacity: opacity,
                }).addTo(dotLayer).bindTooltip(`${escapeHtml(d.fsa)} · sev ${d.severity} · ${escapeHtml(TYPE_LABEL[d.odourType] || d.odourType)}`);
            });
        } catch (err) {
            console.error('dots failed', err);
        }
    }

    function addAshbridgesMarker() {
        // Approximate plant location: 43.660 N, -79.314 W
        const lat = 43.660, lng = -79.314;
        const icon = L.divIcon({
            className: 'ashbridges-icon',
            html: '<div style="position:relative">'
                + '<div style="width:16px;height:16px;border-radius:999px;background:#DA291C;border:2px solid #FAF7F2;box-shadow:0 0 0 1px #1B1B1B"></div>'
                + '<div style="position:absolute;top:-22px;left:-58px;width:140px;text-align:center;font-family:Inter,sans-serif;font-size:10px;font-weight:600;color:#1B1B1B;background:rgba(250,247,242,0.9);padding:2px 6px;border-radius:4px;white-space:nowrap;border:1px solid rgba(27,27,27,0.1)">Ashbridges Bay WTP</div>'
                + '</div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        });
        L.marker([lat, lng], { icon, interactive: false }).addTo(map);
    }

    // ── Recent feed ────────────────────────────────────────────────────────
    async function refreshFeed() {
        const frame = document.getElementById('feedFrame');
        try {
            const { items } = await getJson('/api/reports/recent?limit=20');
            if (!items.length) {
                frame.innerHTML = '<div class="feed-empty">No reports in the window. The raccoon is napping.</div>';
                return;
            }
            frame.innerHTML = items.map(renderFeedItem).join('');
        } catch (err) {
            console.error('feed failed', err);
            frame.innerHTML = "<div class=\"feed-empty\">Couldn't load recent reports.</div>";
        }
    }

    function renderFeedItem(r) {
        // 0 is a valid severity ("all clear" check-in) — keep it instead of falling back to 1.
        const sev = Number.isFinite(Number(r.severity)) ? Number(r.severity) : 1;
        const sevClass = `sev-${sev}`;
        const sevLabel = SEV_LABEL[sev] || 'Strong';
        const isClear = sev === 0;
        const odour = escapeHtml(TYPE_LABEL[r.odourType] || r.odourType || '');
        const note = r.description ? `<span style="opacity:0.85">"${escapeHtml(r.description)}"</span>` : '';
        const intersection = r.intersection
            ? `<span class="feed-intersection">· ${escapeHtml(r.intersection)}</span>`
            : '';
        // Clear check-ins read as data, not a complaint — drop the "· N" suffix and odour tag.
        const badge = isClear
            ? `<span class="sev-badge sev-0"><span class="dot"></span>${sevLabel}</span>`
            : `<span class="sev-badge ${sevClass}"><span class="dot"></span>${sevLabel} · ${sev}</span>`;
        const body = isClear
            ? `<span class="odour-tag odour-tag-clear">no smell reported</span>`
            : `<span class="odour-tag">${odour}</span>${note}`;
        return `
            <div class="feed-item">
                <div class="feed-item-row">
                    <div class="feed-item-meta">
                        <span class="feed-fsa">${escapeHtml(r.fsa)}</span>
                        ${intersection}
                        ${badge}
                    </div>
                    <span class="feed-time">${escapeHtml(formatTimeAgo(r.createdAt))}</span>
                </div>
                <div class="feed-note">
                    ${body}
                </div>
            </div>`;
    }

    // ── Stats + raccoon mood ───────────────────────────────────────────────
    async function refreshStats() {
        try {
            const s = await getJson('/api/reports/stats');
            document.getElementById('statToday').textContent = (s.today ?? 0).toLocaleString('en-CA');
            document.getElementById('statWeek').textContent = (s.thisWeek ?? 0).toLocaleString('en-CA');
            document.getElementById('statYear').textContent = (s.thisYear ?? 0).toLocaleString('en-CA');
            document.getElementById('statReporters').textContent = (s.uniqueReportersThisWeek ?? 0).toLocaleString('en-CA');
            const statClear = document.getElementById('statClear');
            if (statClear) statClear.textContent = (s.clearCheckInsThisWeek ?? 0).toLocaleString('en-CA');

            // s.today counts ALL submissions including all-clear check-ins; the odour signal
            // is today minus clearToday. Mood + headline use the positive count.
            const today = s.today || 0;
            const clearToday = s.clearCheckInsToday || 0;
            const positiveToday = Math.max(0, today - clearToday);
            let mood;
            if (positiveToday === 0) mood = 1;
            else if (positiveToday <= 3) mood = 2;
            else if (positiveToday <= 10) mood = 3;
            else if (positiveToday <= 30) mood = 4;
            else mood = 5;
            renderRaccoon(document.getElementById('raccoonCard'), mood);
            updateHeadline(positiveToday, clearToday, mood);
            renderLakeWave(document.getElementById('lakeWave'), mood);

            // Eyebrow date
            const eyebrow = document.getElementById('eyebrow');
            const today_str = new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
            eyebrow.textContent = `Today's Stench Report · ${today_str}`;
        } catch (err) {
            console.error('stats failed', err);
            renderRaccoon(document.getElementById('raccoonCard'), 1);
            renderLakeWave(document.getElementById('lakeWave'), 1);
        }
    }

    function updateHeadline(positiveToday, clearToday, mood) {
        // <em> elements are styled by the global Honest Ed's CSS rule
        // (yellow highlight pill, rotated). No inline overrides — let the CSS work.
        const h = document.getElementById('heroHeadline');
        if (positiveToday === 0 && clearToday > 0) {
            h.innerHTML = `The raccoon is napping. <em>All clear.</em> ${clearToday} check-in${clearToday === 1 ? '' : 's'} today.`;
        } else if (positiveToday === 0) {
            h.innerHTML = 'The raccoon is napping. <em>All clear.</em>';
        } else if (mood >= 4) {
            h.innerHTML = `It's bad out there. <em>${positiveToday} report${positiveToday === 1 ? '' : 's'}</em> in the last 24 hours.`;
        } else {
            h.innerHTML = "Smelled something? <em>Tell the city what 311 won't capture.</em>";
        }
    }

    // ── Streetcar ticker ───────────────────────────────────────────────────
    async function refreshTicker() {
        try {
            const { items } = await getJson('/api/reports/recent?limit=12');
            const ticker = document.getElementById('ticker');
            const track = document.getElementById('tickerTrack');
            if (!items.length) {
                ticker.hidden = true;
                return;
            }
            ticker.hidden = false;
            const segment = items.map(tickerItem).join('');
            track.innerHTML = segment + segment + segment;
        } catch (err) {
            console.error('ticker failed', err);
        }
    }

    function tickerItem(r) {
        const sev = Number.isFinite(Number(r.severity)) ? Number(r.severity) : 1;
        const odourLabel = sev === 0
            ? 'all clear'
            : escapeHtml(TYPE_LABEL[r.odourType] || r.odourType || '');
        const sevLabel = sev === 0 ? '✓' : `sev ${sev}`;
        return `<span class="ticker-item">
            <span class="ticker-dot">●</span>
            <span>${escapeHtml(r.fsa)}</span>
            <span class="ticker-sep">·</span>
            <span>${escapeHtml(formatTimeAgo(r.createdAt))}</span>
            <span class="ticker-sep">·</span>
            <span>${odourLabel}</span>
            <span class="ticker-sep">·</span>
            <span>${sevLabel}</span>
        </span>`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ── Wind widget ────────────────────────────────────────────────────────
    // Polls /api/weather/current. The server proxies OpenWeatherMap and edge-caches
    // for 10 min; we poll every 5 min so most calls are cache hits.
    const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    function oppositeCardinal(deg) {
        if (!Number.isFinite(deg)) return 'S';
        const normalized = (((deg + 180) % 360) + 360) % 360;
        return CARDINALS[Math.round(normalized / 45) % 8];
    }
    function ensureWindWidget() {
        let el = document.getElementById('windWidget');
        if (el) return el;
        const frame = document.querySelector('.map-frame');
        if (!frame) return null;
        el = document.createElement('div');
        el.id = 'windWidget';
        el.className = 'wind-widget';
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        frame.appendChild(el);
        return el;
    }
    async function refreshWeather() {
        const el = ensureWindWidget();
        if (!el) return;
        try {
            const w = await getJson('/api/weather/current');
            const speed = w.wind && Number.isFinite(w.wind.speedKmh) ? w.wind.speedKmh : null;
            const dir = w.wind && Number.isFinite(w.wind.direction) ? w.wind.direction : null;
            const cardinal = (w.wind && w.wind.cardinal) || (dir != null ? CARDINALS[Math.round((((dir % 360) + 360) % 360) / 45) % 8] : null);
            if (speed == null || dir == null || !cardinal) {
                el.hidden = true;
                return;
            }
            // OWM returns "wind from" angle. The arrow points where the wind is going,
            // so add 180°. For Leslieville: south wind (from south) = arrow points north,
            // smell blows over the neighbourhood.
            const arrowDeg = (dir + 180) % 360;
            const goingTo = oppositeCardinal(dir);
            const observedAt = w.observedAt ? new Date(w.observedAt) : null;
            const ago = observedAt ? formatTimeAgo(observedAt.toISOString()) : '';
            el.innerHTML = `
                <svg class="wind-arrow" style="transform: rotate(${arrowDeg}deg)" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2 L18 14 L12 11 L6 14 Z" fill="currentColor" />
                </svg>
                <div class="wind-meta">
                    <div class="wind-cardinal">${escapeHtml(cardinal)} · ${speed} km/h</div>
                    <div class="wind-sub">observed ${escapeHtml(ago)}</div>
                </div>`;
            el.title = `Wind from ${cardinal}, blowing toward ${goingTo}. Source: OpenWeatherMap, observed ${ago}.`;
            el.hidden = false;
        } catch (err) {
            // 503 (no key, upstream down) or network — hide silently.
            el.hidden = true;
        }
    }

    // Time-window toggle
    document.querySelectorAll('.window-toggle button').forEach((btn) => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.window-toggle button').forEach((b) => {
                b.classList.toggle('active', b === btn);
                b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
            });
            activeWindow = btn.dataset.window;
            const gj = await loadGeojson();
            await Promise.all([refreshHeatmap(gj), refreshDots()]);
        });
    });

    // Boot
    (async function init() {
        renderLegend();
        addAshbridgesMarker();
        const gj = await loadGeojson();
        // Render an initial mood-2 raccoon so the hero isn't empty while stats load.
        renderRaccoon(document.getElementById('raccoonCard'), 2);
        renderLakeWave(document.getElementById('lakeWave'), 1);
        autoBlinkRaccoon(document.getElementById('raccoonCard'));
        await Promise.all([
            refreshHeatmap(gj),
            refreshDots(),
            refreshFeed(),
            refreshStats(),
            refreshTicker(),
            refreshWeather(),
        ]);
        setInterval(async () => {
            await Promise.all([
                refreshHeatmap(gj),
                refreshDots(),
                refreshFeed(),
                refreshStats(),
                refreshTicker(),
            ]);
        }, 60_000);
        // Weather refreshes on its own slower cadence (5 min) — no need to retrigger
        // every minute; the server's edge cache is 10 min anyway.
        setInterval(refreshWeather, 5 * 60_000);
    })();
})();
