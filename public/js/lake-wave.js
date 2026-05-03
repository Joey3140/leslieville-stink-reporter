// lake-wave.js — Lake Ontario footer wave that murks with severity (1..5).
(function () {
    const COLORS = ['#A8C5D6', '#A0BACC', '#8FA8B5', '#7A8A92', '#5A6066', '#3A3E40'];

    function renderLakeWave(target, severity = 1) {
        if (!target) return;
        const idx = Math.max(0, Math.min(5, Math.round(severity)));
        const fill = COLORS[idx];
        target.innerHTML = `
            <svg viewBox="0 0 1440 80" preserveAspectRatio="none" class="lake-wave" aria-hidden="true">
                <path d="M 0 30 Q 180 10 360 30 T 720 30 T 1080 30 T 1440 30 L 1440 80 L 0 80 Z" fill="${fill}" opacity="0.55" />
                <path d="M 0 45 Q 180 28 360 45 T 720 45 T 1080 45 T 1440 45 L 1440 80 L 0 80 Z" fill="${fill}" opacity="0.75" />
                <path d="M 0 60 Q 180 48 360 60 T 720 60 T 1080 60 T 1440 60 L 1440 80 L 0 80 Z" fill="${fill}" />
            </svg>`;
    }

    window.LSV = window.LSV || {};
    window.LSV.renderLakeWave = renderLakeWave;
})();
