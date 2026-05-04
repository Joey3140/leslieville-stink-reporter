// Shared client-side helpers. Loaded ahead of page-specific scripts.
window.LSV = (function () {
    const CLIENT_ID_KEY = 'lsv_client_id';

    function getClientId() {
        let id = localStorage.getItem(CLIENT_ID_KEY);
        if (!id) {
            // 16 random bytes => 32 hex chars
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(CLIENT_ID_KEY, id);
        }
        return id;
    }

    async function getJson(url, opts = {}) {
        const r = await fetch(url, { headers: { Accept: 'application/json' }, ...opts });
        if (!r.ok) {
            let msg = 'Request failed';
            try { const data = await r.json(); msg = data.error || msg; } catch (_e) { /* ignore */ }
            const err = new Error(msg);
            err.status = r.status;
            throw err;
        }
        return r.json();
    }

    async function postJson(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            const err = new Error(data.error || 'Request failed');
            err.status = r.status;
            err.payload = data;
            throw err;
        }
        return data;
    }

    function formatTimeAgo(iso) {
        const d = new Date(iso);
        const ms = Date.now() - d.getTime();
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s ago`;
        const m = Math.round(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h}h ago`;
        const days = Math.round(h / 24);
        return `${days}d ago`;
    }

    const SEV_LABEL = { 0: 'All clear', 1: 'Faint', 3: 'Strong', 5: 'Overwhelming' };
    const SEV_EMOJI = { 0: '✓', 1: '🦝', 3: '😖', 5: '🤢' };
    const TYPE_LABEL = {
        'rotten-eggs': 'rotten eggs',
        sewage: 'sewage',
        manure: 'manure',
        chemical: 'chemical',
        other: 'other',
    };

    return { getClientId, getJson, postJson, formatTimeAgo, SEV_LABEL, SEV_EMOJI, TYPE_LABEL };
})();
