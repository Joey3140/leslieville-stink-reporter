(function () {
    const { getJson, formatTimeAgo, SEV_LABEL, TYPE_LABEL } = window.LSV;
    const { renderRaccoon, severityToMood, autoBlinkRaccoon, renderLakeWave } = window.LSV;

    // ── Map setup ──────────────────────────────────────────────────────────
    // v1.3: tightened to a 7-FSA cluster around Leslieville. M4M+M4L+M4E in the middle,
    // M4J north, M4K west, M5A south-west, M1N (Scarborough) east. Mode B rendering:
    // dashed FSA outlines + 200m grid overlay + dot layer.
    // v1.5: zoom + pan locked to the Toronto-area; wind field overlay added.
    const KEPT_FSAS = ['M4M', 'M4L', 'M4E', 'M4J', 'M4K', 'M5A', 'M1N'];
    const MAP_BOUNDS = L.latLngBounds([43.640, -79.380], [43.715, -79.235]);
    // Toronto-area pan envelope. minZoom 11 keeps the user within Toronto + close
    // suburbs even at maximum zoom-out — broader context without GTA-wide scroll.
    const PAN_BOUNDS = L.latLngBounds([43.40, -79.85], [43.95, -78.85]);
    const map = L.map('map', {
        zoomControl: true, scrollWheelZoom: false, attributionControl: true,
        minZoom: 11, maxZoom: 17,
        maxBounds: PAN_BOUNDS, maxBoundsViscosity: 1.0,
    });
    map.fitBounds(MAP_BOUNDS, { padding: [10, 10] });

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
    let gridLayer = null;
    const dotLayer = L.layerGroup().addTo(map);
    const windFieldLayer = L.layerGroup();
    let windFieldBuilt = false;
    let windFieldVisible = true;        // toggle starts ON; persisted in localStorage below
    let activeWindow = '24h';
    let geojsonCache = null;

    async function loadGeojson() {
        if (geojsonCache) return geojsonCache;
        const r = await fetch('/data/fsa-leslieville.geojson');
        const all = await r.json();
        // Filter to the 7 FSAs we render at this zoom. The server-side allow-list still
        // accepts the full 13 (backward-compat with anyone bookmarking the old form).
        geojsonCache = {
            type: 'FeatureCollection',
            features: (all.features || []).filter((f) => KEPT_FSAS.includes(f.properties.CFSAUID)),
        };
        return geojsonCache;
    }

    function fsaCentroid(geom) {
        const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
        let sx = 0, sy = 0;
        ring.forEach(([x, y]) => { sx += x; sy += y; });
        return [sy / ring.length, sx / ring.length];   // [lat, lng]
    }

    // ── Point-in-polygon helpers (used by the wind-field clipping) ────────
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
    function pointInAnyFsa(lng, lat, features) {
        for (const f of features) if (pointInGeometry(lng, lat, f.geometry)) return true;
        return false;
    }

    function renderLegend() {
        const el = document.getElementById('mapLegend');
        const swatches = HEAT_RAMP.map((c) => `<span style="background:${c}"></span>`).join('');
        el.innerHTML = `<span>Fewer</span><span class="legend-bar">${swatches}</span><span>More</span><span class="legend-sep">200m cells</span>`;
    }

    function setupFsaTooltip(feature, layer, count) {
        const fsa = feature.properties.CFSAUID;
        const tip = document.getElementById('fsaTooltip');
        const showTip = () => {
            tip.innerHTML = `<strong>${escapeHtml(fsa)}</strong><div class="sub">${count} report${count === 1 ? '' : 's'} · ${escapeHtml(activeWindow)}</div>`;
            tip.classList.add('show');
            layer.setStyle({ weight: 2.5, opacity: 0.85, dashArray: null });
        };
        const hideTip = () => {
            tip.classList.remove('show');
            layer.setStyle({ weight: 1.5, opacity: 0.55, dashArray: '6 4' });
        };
        layer.on('mouseover', showTip);
        layer.on('mouseout', hideTip);
        layer.on('click', showTip);
    }

    // FSA polygons are dashed outlines only — granular density is carried by the grid
    // overlay below. The /api/reports/heatmap counts still drive the hover tooltip so a
    // user can see the aggregate per FSA.
    async function refreshFsaOutlines(geojson) {
        try {
            const { counts } = await getJson(`/api/reports/heatmap?window=${activeWindow}`);
            if (fsaLayer) fsaLayer.remove();
            fsaLayer = L.geoJSON(geojson, {
                style: () => ({
                    fillColor: '#1B1B1B', fillOpacity: 0.02,
                    weight: 1.5, color: '#1B1B1B', opacity: 0.55,
                    dashArray: '6 4',
                }),
                onEachFeature: (feature, layer) => {
                    setupFsaTooltip(feature, layer, counts[feature.properties.CFSAUID] || 0);
                },
            }).addTo(map);
            // Static FSA labels at each polygon's approximate centroid.
            geojson.features.forEach((f) => {
                const center = fsaCentroid(f.geometry);
                L.marker(center, {
                    icon: L.divIcon({
                        className: 'fsa-label',
                        html: `<span class="fsa-label-pill">${f.properties.CFSAUID}</span>`,
                        iconSize: [44, 18], iconAnchor: [22, 9],
                    }),
                    interactive: false,
                }).addTo(fsaLayer);
            });
        } catch (err) {
            console.error('fsa outlines failed', err);
        }
    }

    // 200m grid overlay. Bins opt-in dot data into fixed cells covering MAP_BOUNDS.
    // At ~43.66°N: 1° lat ≈ 111 km, 1° lng ≈ 80.7 km → 200m ≈ 0.0018° lat, 0.00248° lng.
    // Severity-0 ("all clear") points are excluded so a flood of clears can't paint a cell red.
    async function refreshGrid() {
        if (gridLayer) { gridLayer.remove(); gridLayer = null; }
        if (activeWindow !== '24h' && activeWindow !== '7d') return;   // dots endpoint only serves 24h/7d
        try {
            const { items } = await getJson(`/api/reports/dots?window=${activeWindow}`);
            if (!items || !items.length) return;
            const cellLat = 0.0018, cellLng = 0.00248;
            const south = MAP_BOUNDS.getSouth(), west = MAP_BOUNDS.getWest();
            const cells = new Map();
            items.forEach((p) => {
                if ((p.severity || 0) === 0) return;   // exclude all-clear from heat
                if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
                const r = Math.floor((p.lat - south) / cellLat);
                const c = Math.floor((p.lng - west) / cellLng);
                if (r < 0 || c < 0) return;
                const k = `${r}_${c}`;
                cells.set(k, (cells.get(k) || 0) + 1);
            });
            if (!cells.size) return;
            gridLayer = L.layerGroup();
            cells.forEach((count, key) => {
                const [r, c] = key.split('_').map(Number);
                const lat0 = south + r * cellLat;
                const lng0 = west + c * cellLng;
                L.rectangle([[lat0, lng0], [lat0 + cellLat, lng0 + cellLng]], {
                    fillColor: colorFor(count),
                    fillOpacity: 0.78,
                    weight: 0.4,
                    color: '#1B1B1B',
                    opacity: 0.18,
                }).bindTooltip(`${count} report${count === 1 ? '' : 's'} · 200m cell · ${activeWindow}`).addTo(gridLayer);
            });
            gridLayer.addTo(map);
        } catch (err) {
            console.error('grid failed', err);
        }
    }

    // ── Wind field overlay ────────────────────────────────────────────────
    // A grid of small arrows clipped to the 7 tracked FSA polygons. Density and
    // arrow size scale with viewport so the field reads cleanly on phones too.
    // Direction is driven by a CSS variable (--wind-rot) updated whenever
    // /api/weather/current returns new data.
    function buildWindField(geojson) {
        if (windFieldBuilt) return;
        windFieldBuilt = true;
        const isMobile = window.matchMedia('(max-width: 720px)').matches;
        const ROWS = isMobile ? 7 : 12;
        const COLS = isMobile ? 9 : 16;
        const ARROW_W = isMobile ? 22 : 32;
        const ARROW_H = isMobile ? 8 : 10;
        const stemEnd = ARROW_W * 0.69;
        const midY = ARROW_H / 2;
        const stemY1 = midY - 1, stemY2 = midY + 1;
        const headY1 = 1, headY2 = ARROW_H - 1;
        const pathD = `M 0 ${stemY1} L ${stemEnd} ${stemY1} L ${stemEnd} ${headY1} L ${ARROW_W} ${midY} L ${stemEnd} ${headY2} L ${stemEnd} ${stemY2} L 0 ${stemY2} Z`;
        const halfW = ARROW_W / 2, halfH = ARROW_H / 2;
        const south = MAP_BOUNDS.getSouth(), north = MAP_BOUNDS.getNorth();
        const west = MAP_BOUNDS.getWest(), east = MAP_BOUNDS.getEast();
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const lat = south + (r + 0.5) * (north - south) / ROWS;
                const lng = west + (c + 0.5) * (east - west) / COLS;
                if (!pointInAnyFsa(lng, lat, geojson.features)) continue;
                const opacity = 0.55 + ((r + c) % 3) * 0.08;
                const delay = ((r * 0.7 + c * 0.41) % 3.2).toFixed(2);
                const html = `<div class="wind-cell" style="--ax:${halfW}px;--ay:${halfH}px">`
                    + `<svg width="${ARROW_W}" height="${ARROW_H}" viewBox="0 0 ${ARROW_W} ${ARROW_H}">`
                    + `<path d="${pathD}" fill="rgba(218,41,28,${opacity})" `
                    +   `style="animation-delay: -${delay}s" /></svg></div>`;
                L.marker([lat, lng], {
                    icon: L.divIcon({
                        className: 'wind-cell-icon',
                        html, iconSize: [0, 0], iconAnchor: [0, 0],
                    }),
                    interactive: false,
                }).addTo(windFieldLayer);
            }
        }
    }

    function applyWindRotation(deg) {
        // OWM "wind from" angle → smell goes opposite + adjust for SVG up-is-down +
        // local +X = east baseline → rot = (windFrom + 180) - 90 = windFrom + 90.
        const rot = (deg + 90) % 360;
        document.documentElement.style.setProperty('--wind-rot', `${rot}deg`);
    }

    function setWindFieldVisible(on) {
        windFieldVisible = on;
        if (on) windFieldLayer.addTo(map);
        else windFieldLayer.remove();
        const btn = document.getElementById('windToggle');
        if (btn) {
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        try { localStorage.setItem('lsv_wind_visible', on ? '1' : '0'); } catch (_e) { /* private mode */ }
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
        // Reporter may have skipped the odour question — keep the row clean instead
        // of rendering an empty <span class="odour-tag"></span>.
        const odourSpan = odour ? `<span class="odour-tag">${odour}</span>` : '';
        const body = isClear
            ? `<span class="odour-tag odour-tag-clear">no smell reported</span>`
            : (odourSpan + note) || `<span class="odour-tag" style="opacity:0.55">type unspecified</span>`;
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
            // Drive the page-wide wind-field arrows from the same data source.
            applyWindRotation(dir);
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
            await Promise.all([refreshFsaOutlines(gj), refreshGrid(), refreshDots()]);
        });
    });

    // Wind toggle button — restores prior state from localStorage on load.
    function wireWindToggle() {
        const btn = document.getElementById('windToggle');
        if (!btn) return;
        let stored;
        try { stored = localStorage.getItem('lsv_wind_visible'); } catch (_e) { stored = null; }
        const initialOn = stored === null ? true : stored === '1';
        setWindFieldVisible(initialOn);
        btn.addEventListener('click', () => setWindFieldVisible(!windFieldVisible));
    }

    // Boot
    (async function init() {
        renderLegend();
        addAshbridgesMarker();
        const gj = await loadGeojson();
        // Build the wind-field grid once; visibility is controlled by the toggle.
        buildWindField(gj);
        wireWindToggle();
        // Hold off on rendering the raccoon + lake wave until refreshStats has the
        // real mood. A placeholder mood here flashes the wrong status for ~1s
        // before being overwritten — empty card + aspect-ratio CSS keeps layout.
        await Promise.all([
            refreshFsaOutlines(gj),
            refreshGrid(),
            refreshDots(),
            refreshFeed(),
            refreshStats(),
            refreshTicker(),
            refreshWeather(),
        ]);
        autoBlinkRaccoon(document.getElementById('raccoonCard'));
        setInterval(async () => {
            await Promise.all([
                refreshFsaOutlines(gj),
                refreshGrid(),
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
