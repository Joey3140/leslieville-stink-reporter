(function () {
    const { getJson, postJson, getClientId, renderRaccoon, renderLakeWave } = window.LSV;

    const form = document.getElementById('reportForm');
    const formMain = document.getElementById('formMain');
    const submitBtn = document.getElementById('submitBtn');
    const statusEl = document.getElementById('formStatus');
    const sevButtons = document.querySelectorAll('.sev-btn');
    const fsaSelect = document.getElementById('fsa');
    const fsaDisplay = document.getElementById('fsaDisplay');
    const fsaSub = document.getElementById('fsaSub');
    const autodetectBtn = document.getElementById('autodetectBtn');
    const shareLocation = document.getElementById('shareLocation');
    const description = document.getElementById('description');
    const charCount = document.getElementById('charCount');
    const turnstileSlot = document.getElementById('turnstileSlot');
    const turnstileLabel = document.getElementById('turnstileLabel');
    const intersectionPicker = document.getElementById('intersectionPicker');
    const intersectionSelect = document.getElementById('intersection');

    let severity = null;
    let lastLocation = null;
    let turnstileWidgetId = null;
    let turnstileSiteKey = null;
    let turnstileToken = null;

    // Render the small raccoons inside each severity button.
    sevButtons.forEach((btn) => {
        const slot = btn.querySelector('.sev-btn-icon');
        const mood = Number(slot.dataset.raccoonMood);
        renderRaccoon(slot, mood);
    });

    // Lake wave at bottom — start at calm; will deepen if user picks high severity.
    renderLakeWave(document.getElementById('lakeWave'), 1);

    // Render a tiny raccoon next to the submit button label
    renderRaccoon(document.getElementById('submitRaccoon'), 2);

    description.addEventListener('input', () => {
        const n = description.value.length;
        charCount.textContent = n;
        charCount.parentElement.classList.toggle('warn', n > 250);
    });

    fsaSelect.addEventListener('change', () => {
        fsaDisplay.textContent = fsaSelect.value || 'M4M';
        fsaSub.textContent = ' · ' + (fsaSelect.options[fsaSelect.selectedIndex].text.split('—')[1]?.trim() || '');
        refreshIntersectionPicker(fsaSelect.value);
    });

    // ── Intersection picker (optional, allow-listed per FSA) ──
    let intersectionsCache = null;
    async function loadIntersectionsList() {
        if (intersectionsCache) return intersectionsCache;
        try {
            const r = await fetch('/data/intersections.json');
            intersectionsCache = await r.json();
        } catch (err) {
            console.warn('intersections.json failed to load — picker disabled', err);
            intersectionsCache = { intersections: [] };
        }
        return intersectionsCache;
    }

    async function refreshIntersectionPicker(currentFsa) {
        const data = await loadIntersectionsList();
        const matches = (data.intersections || []).filter((x) => x.fsa === currentFsa);
        if (matches.length === 0) {
            intersectionPicker.hidden = true;
            intersectionSelect.value = '';
            return;
        }
        const previous = intersectionSelect.value;
        intersectionSelect.innerHTML = '<option value="">— pick one (optional)</option>'
            + matches.map((x) => `<option value="${escapeAttr(x.name)}">${escapeHtml(x.name)}</option>`).join('');
        // Preserve previous selection if it's still valid for the new FSA
        if (previous && matches.find((x) => x.name === previous)) {
            intersectionSelect.value = previous;
        } else {
            intersectionSelect.value = '';
        }
        intersectionPicker.hidden = false;
    }

    function escapeAttr(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Initialise picker for the default FSA (M4M)
    refreshIntersectionPicker(fsaSelect.value);

    sevButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            sevButtons.forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
            severity = Number(btn.dataset.severity);
            // Murk the lake wave to match severity.
            renderLakeWave(document.getElementById('lakeWave'), severity);
            // Update submit-button raccoon — sev=0 ("all clear") shows mood-1 (sleeping).
            const submitMood = severity === 0 ? 1 : Math.max(1, Math.min(5, severity));
            renderRaccoon(document.getElementById('submitRaccoon'), submitMood);
            updateSubmitState();
        });
    });

    // FSA auto-detect via geolocation
    // KEPT_FSAS mirrors the 7 visible on the dashboard; auto-detect only assigns one of these
    // so the value always matches an option in the dropdown. If the user is outside, we ask
    // them to pick the closest manually.
    const KEPT_FSAS = ['M4M', 'M4L', 'M4E', 'M4J', 'M4K', 'M5A', 'M1N'];
    let geojsonCache = null;
    async function guessFsaFromLatLng(lat, lng) {
        if (!geojsonCache) {
            const r = await fetch('/data/fsa-leslieville.geojson');
            geojsonCache = await r.json();
        }
        for (const f of geojsonCache.features) {
            if (!KEPT_FSAS.includes(f.properties.CFSAUID)) continue;
            if (pointInGeometry(lng, lat, f.geometry)) return f.properties.CFSAUID;
        }
        return null;
    }
    function pointInPolygon(lng, lat, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            const intersect = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function pointInGeometry(lng, lat, geom) {
        if (geom.type === 'Polygon') {
            const [outer, ...holes] = geom.coordinates;
            if (!pointInPolygon(lng, lat, outer)) return false;
            return !holes.some((h) => pointInPolygon(lng, lat, h));
        }
        if (geom.type === 'MultiPolygon') {
            return geom.coordinates.some((p) => {
                const [outer, ...holes] = p;
                if (!pointInPolygon(lng, lat, outer)) return false;
                return !holes.some((h) => pointInPolygon(lng, lat, h));
            });
        }
        return false;
    }

    autodetectBtn.addEventListener('click', () => {
        if (!('geolocation' in navigator)) {
            setStatus('Geolocation not supported — pick your area manually.', 'error');
            return;
        }
        autodetectBtn.disabled = true;
        autodetectBtn.textContent = 'Finding you…';
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            lastLocation = { lat: latitude, lng: longitude };
            const fsa = await guessFsaFromLatLng(latitude, longitude);
            if (fsa) {
                fsaSelect.value = fsa;
                fsaSelect.dispatchEvent(new Event('change'));
                setStatus(`Auto-detected ${fsa}.`, 'success');
            } else {
                setStatus('You appear to be outside the watched FSAs — pick the closest manually.', '');
            }
            autodetectBtn.disabled = false;
            autodetectBtn.textContent = 'Use my location';
        }, (err) => {
            setStatus(`Couldn't get your location: ${err.message}`, 'error');
            autodetectBtn.disabled = false;
            autodetectBtn.textContent = 'Use my location';
        }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 });
    });

    function setStatus(msg, kind) {
        statusEl.textContent = msg;
        statusEl.className = 'form-status' + (kind ? ` ${kind}` : '');
    }

    function updateSubmitState() {
        // Severity + FSA are the only user-input requirements. Odour type, intersection,
        // location, and description are all optional.
        const fsa = fsaSelect.value;
        const ready = severity != null && !!fsa && (turnstileToken || !turnstileSiteKey);
        submitBtn.disabled = !ready;
    }

    // Listen for any change in the form to update submit state
    form.addEventListener('change', updateSubmitState);
    form.addEventListener('input', updateSubmitState);

    async function loadConfig() {
        try {
            const cfg = await getJson('/api/config');
            turnstileSiteKey = cfg.turnstileSiteKey;
            if (cfg.submissionsPaused) {
                setStatus('Reports are temporarily paused for maintenance. Please check back soon.', 'error');
                submitBtn.disabled = true;
            }
            if (!turnstileSiteKey) {
                turnstileLabel.textContent = "Verification skipped (dev mode — Turnstile not configured).";
            }
        } catch (err) { console.warn('config load failed', err); }
    }

    function ensureTurnstile() {
        if (!turnstileSiteKey) { updateSubmitState(); return; }
        if (!window.turnstile) { window.addEventListener('load', ensureTurnstile, { once: true }); return; }
        if (turnstileWidgetId !== null) return;
        turnstileWidgetId = window.turnstile.render(turnstileSlot, {
            sitekey: turnstileSiteKey,
            theme: 'light',
            callback: (token) => { turnstileToken = token; updateSubmitState(); },
            'expired-callback': () => { turnstileToken = null; updateSubmitState(); },
        });
    }

    function getTurnstileToken() {
        if (!turnstileSiteKey) return 'XXXX.DUMMY.TOKEN.XXXX';
        return turnstileToken || (window.turnstile && turnstileWidgetId !== null ? window.turnstile.getResponse(turnstileWidgetId) : null);
    }

    function showSuccess(payload) {
        const fsa = fsaSelect.value || 'M4M';
        const time = new Date().toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
        const isClear = severity === 0;
        const sevForRaccoon = isClear ? 1 : Math.min(5, (severity || 2) + 1);
        const headline = isClear ? 'All-clear logged.' : 'Stench logged.';
        const copy = isClear
            ? `Thanks for the all-clear. Logged for <strong>${escapeHtml(fsa)}</strong> at ${escapeHtml(time)}. Helps us track how long these events last.`
            : `Filed for <strong>${escapeHtml(fsa)}</strong> at ${escapeHtml(time)}. The raccoon nodded gravely. Your report is now part of the live public count — anyone (including Coun. Paula Fletcher's office) can see it on the map.`;
        formMain.innerHTML = `
            <div style="text-align:center; padding: 32px 0">
                <div style="display:inline-block; width:180px; height:180px; margin-bottom:24px" id="successRaccoon"></div>
                <h1 style="font-size:44px; margin: 0 0 12px">${escapeHtml(headline)}</h1>
                <p class="lede" style="max-width:480px; margin: 0 auto 28px">${copy}</p>
                <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap">
                    <a href="/" class="btn btn-primary">See the map</a>
                    <a href="/report" class="btn btn-secondary">File another</a>
                </div>
            </div>`;
        renderRaccoon(document.getElementById('successRaccoon'), sevForRaccoon);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (severity == null) { setStatus('Pick a severity.', 'error'); return; }
        if (!fsaSelect.value) { setStatus('Pick your postal area.', 'error'); return; }

        const tok = getTurnstileToken();
        if (!tok) { setStatus('Please complete the captcha.', 'error'); return; }

        const odourEl = form.querySelector('input[name="odourType"]:checked');
        const body = {
            fsa: fsaSelect.value,
            severity,
            description: description.value.trim() || undefined,
            clientId: getClientId(),
            turnstileToken: tok,
        };
        if (odourEl) body.odourType = odourEl.value;
        if (intersectionSelect.value) {
            body.intersection = intersectionSelect.value;
        }
        if (shareLocation.checked && lastLocation) {
            body.approxLat = lastLocation.lat;
            body.approxLng = lastLocation.lng;
        }

        submitBtn.disabled = true;
        setStatus('Sending…', '');
        try {
            const data = await postJson('/api/reports', body);
            if (data.deduped) {
                setStatus("Looks like you reported in the last 30 minutes. Thanks — we count you once.", 'success');
            } else if (data.status === 'pending-review') {
                setStatus("Got it. Your note mentioned what looked like personal info — held for moderation.", 'success');
                showSuccess(data);
            } else {
                showSuccess(data);
            }
        } catch (err) {
            setStatus(err.message || 'Something went wrong.', 'error');
            submitBtn.disabled = false;
        }
    });

    loadConfig().then(ensureTurnstile);
})();
