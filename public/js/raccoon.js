// raccoon.js — Toronto Raccoon Mood Meter.
// Mood: 1 (all clear, napping) → 5 (overwhelming, gas mask, fleeing).
// The art is rendered in Blender from art/raccoon/build.py. The hero spot plays a
// looping clip; everywhere else uses a still, so small icons stay light.

(function () {
    const DESCRIPTIONS = {
        1: 'Raccoon napping beside a green bin with a slice of pizza',
        2: 'Raccoon sniffing the air',
        3: 'Raccoon squinting and waving a smell away',
        4: 'Raccoon crying and pinching its nose',
        5: 'Raccoon fleeing in a gas mask',
    };

    function moodFrom(mood) {
        return Math.max(1, Math.min(5, Math.round(mood) || 1));
    }

    function prefersStill() {
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        return reduced || Boolean(navigator.connection && navigator.connection.saveData);
    }

    function still(src, alt) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = alt;
        img.className = 'raccoon-img';
        img.decoding = 'async';
        return img;
    }

    function clip(m) {
        const poster = `/raccoon/hero-m${m}.webp`;
        if (prefersStill()) return still(poster, DESCRIPTIONS[m]);
        const video = document.createElement('video');
        video.poster = poster;
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('role', 'img');
        video.setAttribute('aria-label', DESCRIPTIONS[m]);
        video.disablePictureInPicture = true;
        for (const [ext, type] of [['webm', 'video/webm'], ['mp4', 'video/mp4']]) {
            const source = document.createElement('source');
            source.src = `/raccoon/hero-m${m}.${ext}`;
            source.type = type;
            video.appendChild(source);
        }
        return video;
    }

    // Render a raccoon into target. size is 'hero' (looping clip), 'icon' (full body
    // still) or 'face' (head only, for very small spots). Safe to call repeatedly:
    // the dashboard refreshes on a timer and must not restart a playing clip.
    function renderRaccoon(target, mood, opts = {}) {
        if (!target) return;
        const m = moodFrom(mood);
        const size = opts.size || 'icon';
        const key = `${size}-${m}`;
        if (target.dataset.raccoon === key) return;
        target.dataset.raccoon = key;
        target.dataset.mood = String(m);
        const alt = opts.decorative ? '' : DESCRIPTIONS[m];
        let el;
        if (size === 'hero') el = clip(m);
        else if (size === 'face') el = still(`/raccoon/face-m${m}.webp`, alt);
        else el = still(`/raccoon/icon-m${m}.webp`, alt);
        target.replaceChildren(el);
        if (el.play) el.play().catch(() => { /* blocked autoplay leaves the poster up */ });
    }

    // Map an average severity (1.0-5.0) to a discrete mood (1-5).
    function severityToMood(sev) {
        if (!Number.isFinite(sev) || sev < 1.2) return 1;
        if (sev < 2.4) return 2;
        if (sev < 3.4) return 3;
        if (sev < 4.2) return 4;
        return 5;
    }

    window.LSV = window.LSV || {};
    window.LSV.renderRaccoon = renderRaccoon;
    window.LSV.severityToMood = severityToMood;
})();
