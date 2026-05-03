// raccoon.js — Toronto Raccoon Mood Meter, vanilla JS port of the geometric variant.
// Mood: 1 (faint, eating trash) → 5 (critical, gas mask, fleeing).
// Renders pure SVG primitives — no external assets.

(function () {
    const FUR     = '#5A5249';
    const FUR_DK  = '#2E2A24';
    const BELLY   = '#C8B89C';
    const PAW     = '#3A352D';
    const NOSE    = '#1B1B1B';
    const EYE     = '#1B1B1B';

    function eyes(mood, blink) {
        if (mood === 5) return '';
        const lookSide = (mood === 2 || mood === 3) ? 1 : 0;
        const irisOff = lookSide ? 3 : 0;
        let out = `
            <ellipse cx="104" cy="108" rx="9" ry="${blink ? 1.2 : 9}" fill="#fff" />
            <ellipse cx="136" cy="108" rx="9" ry="${blink ? 1.2 : 9}" fill="#fff" />`;
        if (!blink) {
            out += `
                <circle cx="${104 + irisOff}" cy="108" r="5" fill="${EYE}" />
                <circle cx="${136 + irisOff}" cy="108" r="5" fill="${EYE}" />
                <circle cx="${104 + irisOff - 1.5}" cy="106.5" r="1.5" fill="#fff" />
                <circle cx="${136 + irisOff - 1.5}" cy="106.5" r="1.5" fill="#fff" />`;
        }
        if (mood === 4) {
            out += `
                <path d="M 99 116 Q 97 124 100 130 Q 103 124 101 116 Z" fill="#7BB6D6" opacity="0.85" />
                <path d="M 141 116 Q 139 124 142 130 Q 145 124 143 116 Z" fill="#7BB6D6" opacity="0.85" />`;
        }
        if (mood === 1) {
            // Sleepy/content eyes — just the closed-eye curves, no hooded-eyelid rects.
            out += `
                <path d="M 96 108 Q 104 112 112 108"  stroke="${EYE}" stroke-width="2.5" fill="none" stroke-linecap="round" />
                <path d="M 128 108 Q 136 112 144 108" stroke="${EYE}" stroke-width="2.5" fill="none" stroke-linecap="round" />`;
        }
        return out;
    }

    function noseAndMouth(mood) {
        if (mood === 5) return '';
        let mouth = '';
        if (mood === 1) mouth = `<path d="M 114 134 Q 120 140 126 134" stroke="${NOSE}" stroke-width="1.8" fill="none" stroke-linecap="round" />`;
        if (mood === 2) mouth = `<path d="M 116 136 Q 120 138 124 136" stroke="${NOSE}" stroke-width="1.8" fill="none" stroke-linecap="round" />`;
        if (mood === 3) mouth = `<path d="M 114 138 L 126 138" stroke="${NOSE}" stroke-width="1.8" fill="none" stroke-linecap="round" />`;
        if (mood === 4) mouth = `<ellipse cx="120" cy="140" rx="5" ry="4" fill="${NOSE}" />`;
        return `<ellipse cx="120" cy="124" rx="5" ry="3.5" fill="${NOSE}" />${mouth}`;
    }

    function paws(mood) {
        if (mood === 1) return `
            <ellipse cx="148" cy="138" rx="10" ry="7" fill="${PAW}" transform="rotate(-30 148 138)" />
            <circle cx="143" cy="132" r="4" fill="#9C7B4E" />`;
        if (mood === 2) return `<ellipse cx="158" cy="150" rx="11" ry="8" fill="${PAW}" transform="rotate(-15 158 150)" />`;
        if (mood === 3) return `
            <ellipse cx="78"  cy="158" rx="11" ry="8" fill="${PAW}" transform="rotate(20 78 158)" />
            <ellipse cx="162" cy="158" rx="11" ry="8" fill="${PAW}" transform="rotate(-20 162 158)" />`;
        if (mood === 4) return `
            <ellipse cx="108" cy="124" rx="10" ry="7" fill="${PAW}" />
            <ellipse cx="132" cy="124" rx="10" ry="7" fill="${PAW}" />`;
        return '';
    }

    function gasMask() {
        return `
            <ellipse cx="120" cy="118" rx="36" ry="30" fill="#3A4A3F" />
            <ellipse cx="120" cy="118" rx="36" ry="30" fill="none" stroke="#1B1B1B" stroke-width="1.5" />
            <circle cx="106" cy="112" r="9" fill="#D4E4D8" stroke="#1B1B1B" stroke-width="1" />
            <circle cx="134" cy="112" r="9" fill="#D4E4D8" stroke="#1B1B1B" stroke-width="1" />
            <rect x="112" y="138" width="16" height="14" rx="2" fill="#2A332E" stroke="#1B1B1B" stroke-width="1" />
            <rect x="115" y="140" width="10" height="2" fill="#7FA88F" />
            <path d="M 84 110 Q 70 100 76 86" stroke="#3A4A3F" stroke-width="3" fill="none" />
            <path d="M 156 110 Q 170 100 164 86" stroke="#3A4A3F" stroke-width="3" fill="none" />`;
    }

    function trashCan() {
        return `
            <g transform="translate(150, 130)">
                <rect x="0"  y="6" width="56" height="64" rx="3" fill="#4A4640" />
                <rect x="0"  y="6" width="56" height="6"  rx="2" fill="#2E2A24" />
                <rect x="-4" y="0" width="64" height="8"  rx="2" fill="#2E2A24" transform="rotate(-8 28 4)" />
                <line x1="6"  y1="20" x2="6"  y2="68" stroke="#2E2A24" stroke-width="1" />
                <line x1="50" y1="20" x2="50" y2="68" stroke="#2E2A24" stroke-width="1" />
                <path d="M 8 0 L 14 -8 L 22 -2 L 28 -10 L 36 -4 L 44 -12" stroke="#9C7B4E" stroke-width="2" fill="none" />
            </g>`;
    }

    function speedLines() {
        return `
            <g stroke="#1B1B1B" stroke-width="2" opacity="0.35" stroke-linecap="round">
                <line x1="195" y1="60"  x2="225" y2="55"  />
                <line x1="200" y1="100" x2="230" y2="98"  />
                <line x1="195" y1="140" x2="225" y2="142" />
                <line x1="190" y1="180" x2="220" y2="184" />
            </g>`;
    }

    function tail(mood) {
        const tx = mood >= 4 ? 60 : 70;
        const ty = mood === 5 ? 110 : 130;
        const rot = mood === 5 ? -25 : -10;
        return `
            <g transform="translate(${tx}, ${ty}) rotate(${rot})">
                <ellipse cx="0" cy="0"   rx="14" ry="38" fill="${FUR}" />
                <ellipse cx="0" cy="-22" rx="14" ry="6"  fill="${FUR_DK}" />
                <ellipse cx="0" cy="-6"  rx="14" ry="6"  fill="${FUR_DK}" />
                <ellipse cx="0" cy="10"  rx="14" ry="6"  fill="${FUR_DK}" />
                <ellipse cx="0" cy="26"  rx="13" ry="6"  fill="${FUR_DK}" />
            </g>`;
    }

    function buildSvg(mood, blink) {
        const m = Math.max(1, Math.min(5, Math.round(mood) || 1));
        return `<svg viewBox="0 0 240 240" role="img" aria-label="Raccoon mood ${m}" style="display:block">
            ${m === 1 ? trashCan() : ''}
            ${m === 5 ? speedLines() : ''}
            ${tail(m)}
            <ellipse cx="120" cy="160" rx="52" ry="46" fill="${FUR}" />
            <ellipse cx="120" cy="170" rx="34" ry="30" fill="${BELLY}" />
            <circle cx="78"  cy="78" r="16" fill="${FUR}" />
            <circle cx="162" cy="78" r="16" fill="${FUR}" />
            <circle cx="78"  cy="80" r="8"  fill="${FUR_DK}" />
            <circle cx="162" cy="80" r="8"  fill="${FUR_DK}" />
            <ellipse cx="120" cy="105" rx="58" ry="50" fill="${FUR}" />
            <path d="M 70 100 Q 78 88 96 90 Q 110 92 116 102 Q 122 92 144 90 Q 162 88 170 100 Q 168 116 152 122 Q 140 124 124 118 Q 120 116 116 118 Q 100 124 88 122 Q 72 116 70 100 Z" fill="${FUR_DK}" />
            <path d="M 110 60 L 120 92 L 130 60 Q 120 70 110 60 Z" fill="${BELLY}" opacity="0.85" />
            <ellipse cx="120" cy="128" rx="22" ry="16" fill="${BELLY}" />
            ${eyes(m, !!blink)}
            ${noseAndMouth(m)}
            ${paws(m)}
            ${m === 5 ? gasMask() : ''}
        </svg>`;
    }

    // Render a raccoon at given mood into target element. Idempotent.
    function renderRaccoon(target, mood, opts = {}) {
        if (!target) return;
        target.innerHTML = buildSvg(mood, opts.blink);
        target.dataset.mood = String(mood);
    }

    // Map an average severity (1.0-5.0) to a discrete mood (1-5).
    function severityToMood(sev) {
        if (!Number.isFinite(sev) || sev < 1.2) return 1;
        if (sev < 2.4) return 2;
        if (sev < 3.4) return 3;
        if (sev < 4.2) return 4;
        return 5;
    }

    // Auto-blink: gentle blink animation for hero raccoons.
    function autoBlink(target) {
        if (!target) return () => {};
        let blink = false;
        const tick = () => {
            const mood = Number(target.dataset.mood) || 2;
            blink = true; renderRaccoon(target, mood, { blink });
            setTimeout(() => { blink = false; renderRaccoon(target, mood, { blink }); }, 160);
        };
        const id = setInterval(tick, 4200 + Math.random() * 2000);
        return () => clearInterval(id);
    }

    window.LSV = window.LSV || {};
    window.LSV.renderRaccoon = renderRaccoon;
    window.LSV.severityToMood = severityToMood;
    window.LSV.autoBlinkRaccoon = autoBlink;
})();
