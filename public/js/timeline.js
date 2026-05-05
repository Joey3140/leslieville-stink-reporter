// Timeline scrubber for the dashboard map.
//
// Phase 1 — histogram strip of hourly report volume across the last 30 days.
// Phase 2 — draggable thumb + Live pill + play/pause sitting on the same strip.
// Phase 3 — track-extent presets (1h/8h/24h/7d/30d/all) repurposed from the
//           old map time-window toggle, plus a ±window picker. The map's dot,
//           grid, and FSA-polygon layers are now driven entirely by the
//           prefetched 30-day cache filtered to (currentTime ± windowMs/2).
//
// State of truth for "what time the map is showing":
//   - isLive=true        → currentTime tracks Date.now()
//   - isLive=false       → currentTime is frozen at the user's chosen instant
//   - windowMs           → ±half-window around currentTime that the layers reflect
//   - trackExtentMs      → visible span on the strip (controlled by .window-toggle)
//
// DOM events (on document):
//   - lsv:scrub          { at, windowMs, isLive }
//   - lsv:timeline-cache { count, generatedAt }
// window.LSV.timeline:
//   - getReports()       → cached items[]
//   - getState()         → { currentTime, windowMs, trackExtentMs, isLive, anchorMs }
//   - setAt(ms)          → programmatic scrub
//   - setWindow(ms)      → set ±window total span
//   - setTrackExtent(ms) → set visible strip span
//   - snapToLive()
(function () {
    const { getJson } = window.LSV;

    const HOURS = 30 * 24;
    const HOUR_MS = 60 * 60 * 1000;
    const RANGE_MS = HOURS * HOUR_MS;
    const PLAY_FRAME_MS = 600;
    const HEAT_RAMP = ['#F4EFE3', '#EFE3C2', '#E5D08A', '#E5A756', '#C97A35', '#B8552A', '#8E331C', '#6B1F12'];

    // Track-extent presets — used to size what's visible on the strip. Match the
    // data-extent attribute values on the .window-toggle buttons in index.html.
    const EXTENT_MS = {
        '1h': 1 * HOUR_MS,
        '8h': 8 * HOUR_MS,
        '24h': 24 * HOUR_MS,
        '7d': 7 * 24 * HOUR_MS,
        '30d': 30 * 24 * HOUR_MS,
        'all': 30 * 24 * HOUR_MS,        // capped at TTL
    };
    // ±window total-span presets (windowMs is total span; "±30m" = 60min).
    const WINDOW_PRESETS = [
        { label: '±10m', ms: 20 * 60 * 1000 },
        { label: '±30m', ms: 60 * 60 * 1000 },     // default
        { label: '±2h',  ms:  4 * 60 * 60 * 1000 },
        { label: '±24h', ms: 48 * 60 * 60 * 1000 },
    ];
    const DEFAULT_WINDOW_MS = WINDOW_PRESETS[1].ms;
    const DEFAULT_EXTENT_MS = EXTENT_MS['24h'];

    function colorFor(count) {
        if (!count)      return HEAT_RAMP[0];
        if (count <= 1)  return HEAT_RAMP[2];
        if (count <= 2)  return HEAT_RAMP[3];
        if (count <= 4)  return HEAT_RAMP[4];
        if (count <= 8)  return HEAT_RAMP[5];
        if (count <= 16) return HEAT_RAMP[6];
        return HEAT_RAMP[7];
    }

    const state = {
        items: [],
        anchorMs: Date.now(),
        currentTime: Date.now(),
        windowMs: DEFAULT_WINDOW_MS,
        trackExtentMs: DEFAULT_EXTENT_MS,
        isLive: true,
        isPlaying: false,
        playTimer: null,
        isDragging: false,
    };

    let elements = null;

    // ── Histogram bins (always hourly across the full 30d range; the visible
    //     portion is selected by adjusting the SVG viewBox in renderHistogram). ──
    function binByHour(items, anchor) {
        const bins = new Array(HOURS).fill(0);
        const oldest = anchor - RANGE_MS;
        items.forEach((r) => {
            if ((r.severity || 0) === 0) return;
            const t = new Date(r.createdAt).getTime();
            if (!Number.isFinite(t)) return;
            const idx = Math.floor((t - oldest) / HOUR_MS);
            if (idx < 0 || idx >= HOURS) return;
            bins[idx] += 1;
        });
        return bins;
    }

    function renderHistogram() {
        const bins = binByHour(state.items, state.anchorMs);
        const total = bins.reduce((a, b) => a + b, 0);
        // Crop to the visible portion. visibleBins = trackExtentMs / HOUR_MS,
        // rendered as the rightmost N bars.
        const visibleBins = Math.max(1, Math.ceil(state.trackExtentMs / HOUR_MS));
        const startIdx = Math.max(0, HOURS - visibleBins);
        const visible = bins.slice(startIdx);
        const max = Math.max(1, ...visible);
        const heightFor = (n) => (n === 0 ? 0 : Math.max(3, Math.round(100 * Math.sqrt(n / max))));
        const bars = visible.map((n, i) => {
            if (!n) return '';
            const h = heightFor(n);
            return `<rect x="${i}" y="${100 - h}" width="1" height="${h}" fill="${colorFor(n)}" />`;
        }).join('');
        elements.svg.setAttribute('viewBox', `0 0 ${visibleBins} 100`);
        elements.svg.innerHTML = `<rect x="0" y="0" width="${visibleBins}" height="100" fill="var(--ink-08)" />${bars}`;
        const visibleTotal = visible.reduce((a, b) => a + b, 0);
        const peakLabel = max > 1 ? ` · peak ${max}/h` : '';
        elements.total.textContent = `${visibleTotal} report${visibleTotal === 1 ? '' : 's'} in view${peakLabel} (30d total: ${total})`;
        renderAxis();
    }

    function axisLabelsForExtent(ext) {
        const m = 60_000, h = 60 * m, d = 24 * h;
        if (ext <= 1 * h)  return ['1h ago', '45m', '30m', '15m', 'now'];
        if (ext <= 8 * h)  return ['8h ago', '6h',  '4h',  '2h',  'now'];
        if (ext <= 24 * h) return ['24h ago', '18h', '12h', '6h',  'now'];
        if (ext <= 7 * d)  return ['7d ago', '5d',  '3d',  '1d',  'now'];
        return ['30d ago', '14d', '7d', '24h', 'now'];
    }
    function renderAxis() {
        const labels = axisLabelsForExtent(state.trackExtentMs);
        elements.axis.innerHTML = labels.map((l) => `<span>${l}</span>`).join('');
    }

    // ── Scrubber state → DOM ───────────────────────────────────────────────
    function pctFor(at) {
        const oldest = state.anchorMs - state.trackExtentMs;
        return Math.max(0, Math.min(1, (at - oldest) / state.trackExtentMs));
    }
    function timeForPct(pct) {
        const oldest = state.anchorMs - state.trackExtentMs;
        return oldest + Math.max(0, Math.min(1, pct)) * state.trackExtentMs;
    }

    function fmtReadout(at, isLive) {
        if (isLive) return 'Live · now';
        const d = new Date(at);
        const date = d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
        return `${date} · ${time}`;
    }

    function renderScrubUi() {
        const oldestVisible = state.anchorMs - state.trackExtentMs;
        // If the thumb time is older than the visible range, the band+thumb
        // would render off-strip. Clamp visually but keep state intact —
        // setTrackExtent is responsible for snapping currentTime when it
        // shrinks below where the thumb sits.
        const pct = pctFor(state.currentTime);
        const bandHalfPct = (state.windowMs / 2) / state.trackExtentMs;
        elements.thumb.style.left = `${pct * 100}%`;
        elements.band.style.left = `${Math.max(0, pct - bandHalfPct) * 100}%`;
        elements.band.style.width = `${Math.min(1, Math.min(1 - Math.max(0, pct - bandHalfPct), bandHalfPct * 2)) * 100}%`;
        elements.readout.textContent = fmtReadout(state.currentTime, state.isLive);
        elements.livePill.classList.toggle('is-live', state.isLive);
        elements.livePill.setAttribute('aria-pressed', state.isLive ? 'true' : 'false');
        elements.root.classList.toggle('is-scrubbed', !state.isLive);
        elements.play.classList.toggle('is-playing', state.isPlaying);
        elements.play.textContent = state.isPlaying ? '❚❚' : '▶';
        elements.play.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
        // Mark the active extent + window picker buttons.
        elements.extentButtons.forEach((b) => {
            const active = EXTENT_MS[b.dataset.extent] === state.trackExtentMs;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        elements.windowButtons.forEach((b) => {
            const active = +b.dataset.windowMs === state.windowMs;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        // ARIA: expose slider position in seconds so screen readers can read it.
        // valuetext is the human-friendly label that JAWS / NVDA / VoiceOver speak.
        const strip = elements.strip;
        strip.setAttribute('aria-valuemin', String(Math.round(oldestVisible / 1000)));
        strip.setAttribute('aria-valuemax', String(Math.round(state.anchorMs / 1000)));
        strip.setAttribute('aria-valuenow', String(Math.round(state.currentTime / 1000)));
        strip.setAttribute('aria-valuetext', state.isLive
            ? `Live, now, window ${windowLabelFor(state.windowMs)}`
            : `${fmtReadout(state.currentTime, false)}, window ${windowLabelFor(state.windowMs)}`);
        // Communicates the 30-day TTL boundary visually — the leftmost slice of
        // the strip fades out only when we're showing the full extent (anything
        // smaller is fully inside the data window).
        elements.root.classList.toggle('shows-edge', state.trackExtentMs >= EXTENT_MS['30d']);
    }

    function windowLabelFor(windowMs) {
        const half = windowMs / 2;
        const m = 60_000, h = 60 * m, d = 24 * h;
        if (half < h) return `±${Math.round(half / m)}m`;
        if (half < d) return `±${Math.round(half / h)}h`;
        return `±${Math.round(half / d)}d`;
    }

    function emitScrub() {
        document.dispatchEvent(new CustomEvent('lsv:scrub', {
            detail: {
                at: state.currentTime,
                windowMs: state.windowMs,
                isLive: state.isLive,
            },
        }));
    }

    function setAt(ms, { live = false } = {}) {
        const oldest = state.anchorMs - state.trackExtentMs;
        let clamped = Math.max(oldest, Math.min(state.anchorMs, ms));
        const nearLive = state.anchorMs - clamped < 60 * 1000;
        const isLive = !!live || nearLive;
        if (isLive) clamped = state.anchorMs;
        state.currentTime = clamped;
        state.isLive = isLive;
        renderScrubUi();
        emitScrub();
    }

    function snapToLive() {
        stopPlay();
        setAt(state.anchorMs, { live: true });
    }

    function setWindow(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        state.windowMs = ms;
        renderScrubUi();
        emitScrub();
    }

    function setTrackExtent(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        state.trackExtentMs = ms;
        // If the currently-scrubbed instant is no longer within the visible
        // range, snap back to live so the user sees something coherent.
        const oldestVisible = state.anchorMs - ms;
        if (state.currentTime < oldestVisible) {
            snapToLive();
            return;
        }
        renderHistogram();
        renderScrubUi();
    }

    function stepForward() {
        if (state.isLive) { stopPlay(); return; }
        // Step ≈ 5% of the visible track per frame so playback feels coherent
        // at any extent: 1h extent → 3min/frame, 30d extent → ~1.5d/frame.
        const step = Math.max(60_000, Math.round(state.trackExtentMs * 0.05));
        const next = state.currentTime + step;
        if (next >= state.anchorMs) { snapToLive(); return; }
        setAt(next);
    }

    function startPlay() {
        if (state.isPlaying) return;
        if (state.isLive) {
            // Rewind to ~75% of the visible track so playback has somewhere to go.
            setAt(state.anchorMs - state.trackExtentMs * 0.75);
        }
        state.isPlaying = true;
        renderScrubUi();
        state.playTimer = setInterval(stepForward, PLAY_FRAME_MS);
    }
    function stopPlay() {
        if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
        state.isPlaying = false;
        renderScrubUi();
    }
    function togglePlay() { state.isPlaying ? stopPlay() : startPlay(); }

    // ── Pointer drag on the strip ──────────────────────────────────────────
    function pctFromEvent(e) {
        const rect = elements.strip.getBoundingClientRect();
        return (e.clientX - rect.left) / rect.width;
    }
    function wirePointer() {
        const onDown = (e) => {
            stopPlay();
            state.isDragging = true;
            elements.root.classList.add('is-dragging');
            elements.strip.setPointerCapture?.(e.pointerId);
            setAt(timeForPct(pctFromEvent(e)));
        };
        const onMove = (e) => {
            if (!state.isDragging) return;
            setAt(timeForPct(pctFromEvent(e)));
        };
        const onUp = (e) => {
            if (!state.isDragging) return;
            state.isDragging = false;
            elements.root.classList.remove('is-dragging');
            elements.strip.releasePointerCapture?.(e.pointerId);
        };
        elements.strip.addEventListener('pointerdown', onDown);
        elements.strip.addEventListener('pointermove', onMove);
        elements.strip.addEventListener('pointerup', onUp);
        elements.strip.addEventListener('pointercancel', onUp);
    }

    // Keyboard shortcuts on the slider — the strip already has tabindex=0 and
    // role=slider, so it's reachable by Tab. Step size scales with extent so
    // the same key repeats feel comparable at every zoom level. Min step is
    // 1 minute so 1-hour extent is still scrubable at 5%/frame = 3 min.
    function wireKeyboard() {
        elements.strip.addEventListener('keydown', (e) => {
            const baseStep = Math.max(60_000, Math.round(state.trackExtentMs * 0.05));
            const big = baseStep * 5;
            let handled = true;
            switch (e.key) {
                case 'ArrowLeft':
                    setAt(state.currentTime - (e.shiftKey ? big : baseStep));
                    break;
                case 'ArrowRight':
                    setAt(state.currentTime + (e.shiftKey ? big : baseStep));
                    break;
                case 'Home':
                    setAt(state.anchorMs - state.trackExtentMs);
                    break;
                case 'End':
                    snapToLive();
                    break;
                case ' ':
                case 'Enter':
                    togglePlay();
                    break;
                default:
                    handled = false;
            }
            if (handled) e.preventDefault();
        });
    }

    // ── Track-extent toggle (lives outside #mapTimeline; handler here so the
    //     map module no longer owns activeWindow). ──
    function wireExtentToggle() {
        const buttons = Array.from(document.querySelectorAll('.window-toggle [data-extent]'));
        buttons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const ms = EXTENT_MS[btn.dataset.extent];
                if (!ms) return;
                setTrackExtent(ms);
            });
        });
        return buttons;
    }

    // ── DOM mount ──────────────────────────────────────────────────────────
    function mount(root) {
        const windowButtonsHtml = WINDOW_PRESETS.map((p) =>
            `<button data-window-ms="${p.ms}" type="button" role="tab"${p.ms === DEFAULT_WINDOW_MS ? ' class="active" aria-selected="true"' : ''}>${p.label}</button>`
        ).join('');
        root.innerHTML = `
            <header class="timeline-meta">
                <div class="timeline-meta-left">
                    <button class="scrub-play" type="button" aria-label="Play">▶</button>
                    <span class="timeline-label">Report volume</span>
                </div>
                <div class="timeline-meta-right">
                    <div class="scrub-window-picker" role="tablist" aria-label="Window size around cursor">
                        ${windowButtonsHtml}
                    </div>
                    <span class="scrub-readout" aria-live="polite">Live · now</span>
                    <button class="scrub-live-pill is-live" type="button" aria-pressed="true" aria-label="Snap to live">
                        <span class="scrub-live-dot"></span>Live
                    </button>
                </div>
                <span class="timeline-total" aria-live="polite"></span>
            </header>
            <div class="timeline-strip" role="slider" tabindex="0" aria-label="Scrub through report history" aria-valuemin="0" aria-valuemax="100" title="Reports auto-delete after 30 days">
                <svg class="timeline-svg" viewBox="0 0 ${HOURS} 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"></svg>
                <div class="scrub-band" aria-hidden="true"></div>
                <div class="scrub-thumb" aria-hidden="true"></div>
            </div>
            <div class="timeline-axis" aria-hidden="true"></div>
        `;
        elements = {
            root,
            svg: root.querySelector('svg.timeline-svg'),
            strip: root.querySelector('.timeline-strip'),
            thumb: root.querySelector('.scrub-thumb'),
            band: root.querySelector('.scrub-band'),
            readout: root.querySelector('.scrub-readout'),
            total: root.querySelector('.timeline-total'),
            play: root.querySelector('.scrub-play'),
            livePill: root.querySelector('.scrub-live-pill'),
            axis: root.querySelector('.timeline-axis'),
            windowButtons: Array.from(root.querySelectorAll('.scrub-window-picker [data-window-ms]')),
            extentButtons: [],   // populated below
        };
        elements.play.addEventListener('click', togglePlay);
        elements.livePill.addEventListener('click', snapToLive);
        elements.windowButtons.forEach((btn) => {
            btn.addEventListener('click', () => setWindow(+btn.dataset.windowMs));
        });
        elements.extentButtons = wireExtentToggle();
        wirePointer();
        wireKeyboard();
        renderAxis();
    }

    function renderEmpty(message) {
        elements.root.innerHTML = `<div class="timeline-empty">${message}</div>`;
        elements = null;
    }

    // ── Cache fetch ────────────────────────────────────────────────────────
    async function refreshCache() {
        try {
            const data = await getJson('/api/reports/timeline');
            state.items = data.items || [];
            state.anchorMs = data.generatedAt ? new Date(data.generatedAt).getTime() : Date.now();
            if (state.isLive) state.currentTime = state.anchorMs;
            renderHistogram();
            renderScrubUi();
            // Strip out the loading skeleton class once we've rendered real data.
            if (elements && elements.root.classList.contains('is-loading')) {
                elements.root.classList.remove('is-loading');
            }
            document.dispatchEvent(new CustomEvent('lsv:timeline-cache', {
                detail: { count: state.items.length, generatedAt: state.anchorMs },
            }));
            if (data.truncated) console.warn('timeline truncated at', state.items.length, 'items');
        } catch (err) {
            console.error('timeline cache fetch failed', err);
        }
    }

    function init() {
        const root = document.getElementById('mapTimeline');
        if (!root) return;
        mount(root);
        // Skeleton pulse while we wait for the first cache fetch. Removed
        // inside refreshCache() the moment real data arrives.
        root.classList.add('is-loading');
        refreshCache().then(() => {
            // Fire an initial scrub event so the map renders its layers from
            // the cache on first load — Phase 3 removed the live /heatmap and
            // /dots fetches that previously did this.
            emitScrub();
        });
        setInterval(() => {
            if (state.isDragging) return;
            refreshCache();
        }, 60_000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.LSV.timeline = {
        getReports: () => state.items,
        getState: () => ({
            currentTime: state.currentTime,
            windowMs: state.windowMs,
            trackExtentMs: state.trackExtentMs,
            isLive: state.isLive,
            anchorMs: state.anchorMs,
        }),
        setAt,
        setWindow,
        setTrackExtent,
        snapToLive,
    };
})();
