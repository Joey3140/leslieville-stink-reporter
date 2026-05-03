(function () {
    const { getJson, postJson, renderLakeWave } = window.LSV;

    const form = document.getElementById('subscribeForm');
    const formMain = document.getElementById('formMain');
    const emailInput = document.getElementById('email');
    const submitBtn = document.getElementById('submitBtn');
    const statusEl = document.getElementById('formStatus');
    const thresholdInput = document.getElementById('threshold');
    const thresholdReadout = document.getElementById('thresholdReadout');
    const turnstileSlot = document.getElementById('turnstileSlot');
    const turnstileLabel = document.getElementById('turnstileLabel');

    let turnstileSiteKey = null;
    let turnstileWidgetId = null;
    let turnstileToken = null;

    renderLakeWave(document.getElementById('lakeWave'), 1);

    thresholdInput.addEventListener('input', () => {
        thresholdReadout.textContent = `${thresholdInput.value}+`;
    });

    function setStatus(msg, kind) {
        statusEl.textContent = msg;
        statusEl.className = 'form-status' + (kind ? ` ${kind}` : '');
    }

    async function loadConfig() {
        try {
            const cfg = await getJson('/api/config');
            turnstileSiteKey = cfg.turnstileSiteKey;
            if (!turnstileSiteKey) turnstileLabel.textContent = "Verification skipped (dev mode — Turnstile not configured).";
        } catch (err) { console.warn('config load failed', err); }
    }
    function ensureTurnstile() {
        if (!turnstileSiteKey) return;
        if (!window.turnstile) { window.addEventListener('load', ensureTurnstile, { once: true }); return; }
        if (turnstileWidgetId !== null) return;
        turnstileWidgetId = window.turnstile.render(turnstileSlot, {
            sitekey: turnstileSiteKey, theme: 'light',
            callback: (t) => { turnstileToken = t; },
            'expired-callback': () => { turnstileToken = null; },
        });
    }
    function getToken() {
        if (!turnstileSiteKey) return 'XXXX.DUMMY.TOKEN.XXXX';
        return turnstileToken || (window.turnstile && turnstileWidgetId !== null ? window.turnstile.getResponse(turnstileWidgetId) : null);
    }

    function showPostcardSuccess(email, fsas) {
        const today = new Date();
        const stamp = today.toLocaleDateString('en-CA', { day: '2-digit', month: 'short', year: '2-digit' })
            .replace(/\s/g, '·').toUpperCase();
        formMain.innerHTML = `
            <div class="postcard-success">
                <div class="postcard">
                    <div class="postcard-greeting">Greetings from Leslieville</div>
                    <div class="postcard-body">
                        Dear neighbour,<br>
                        Confirmation sent to <strong>${escapeHtml(email)}</strong>. Click the link in your email and we'll start watching the air for you.
                    </div>
                    <div class="postcard-stamp">STAMP</div>
                    <div class="postcard-date">${escapeHtml(stamp)}</div>
                </div>
                <h1 style="font-family:var(--serif); font-size:38px; font-weight:500; margin:0 0 8px">Postcard's in the mail.</h1>
                <p class="lede" style="margin: 0 0 24px">Check your inbox for a confirmation link. We'll only email when ${escapeHtml(fsas.join(', '))} hits your threshold.</p>
                <a href="/" class="btn btn-primary">Back to the map</a>
            </div>`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const email = emailInput.value.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setStatus('Please enter a valid email.', 'error');
            return;
        }
        const fsas = Array.from(form.querySelectorAll('input[name="fsa"]:checked')).map((el) => el.value);
        if (fsas.length === 0) { setStatus('Pick at least one area.', 'error'); return; }

        const token = getToken();
        if (!token) { setStatus('Please complete the captcha.', 'error'); return; }

        const thresholdSeverity = Number(thresholdInput.value);
        submitBtn.disabled = true;
        setStatus('Sending…', '');
        try {
            await postJson('/api/subscribers', { email, fsas, thresholdSeverity, turnstileToken: token });
            showPostcardSuccess(email, fsas);
        } catch (err) {
            setStatus(err.message || 'Something went wrong.', 'error');
            submitBtn.disabled = false;
        }
    });

    loadConfig().then(ensureTurnstile);
})();
