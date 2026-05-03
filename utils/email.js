const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { createChild } = require('./logger');

const log = createChild('email');

let cachedClient = null;
function getClient() {
    if (cachedClient) return cachedClient;
    const key = process.env.RESEND_API_KEY;
    if (!key) {
        log.warn('RESEND_API_KEY not configured — email sends will be no-ops');
        return null;
    }
    cachedClient = new Resend(key);
    return cachedClient;
}

const FROM = process.env.RESEND_FROM || 'Leslieville Stink Reporter <onboarding@resend.dev>';
const TEMPLATE_DIR = path.join(__dirname, '..', 'email-templates');
const templateCache = {};

function loadTemplate(name) {
    if (templateCache[name]) return templateCache[name];
    const file = path.join(TEMPLATE_DIR, `${name}.html`);
    const text = fs.readFileSync(file, 'utf8');
    templateCache[name] = text;
    return text;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Replace {{ key }} occurrences. All values are HTML-escaped so template authors
// don't have to think about it. Use {{{ key }}} for raw HTML (rare — confirm/unsubscribe links).
function render(template, data) {
    return template
        .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, k) => (data[k] != null ? data[k] : ''))
        .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (data[k] != null ? escapeHtml(data[k]) : ''));
}

async function send({ to, subject, template, data, replyTo }) {
    const client = getClient();
    if (!client) {
        log.info({ to, subject, template }, 'email send skipped (no RESEND_API_KEY)');
        return { skipped: true };
    }
    const html = render(loadTemplate(template), data);
    try {
        const result = await client.emails.send({
            from: FROM,
            to,
            subject,
            html,
            replyTo: replyTo || undefined,
        });
        log.info({ to, subject, template, id: result?.data?.id }, 'email sent');
        return result;
    } catch (err) {
        log.error({ err, to, subject, template }, 'email send failed');
        throw err;
    }
}

async function sendBatch(messages) {
    const client = getClient();
    if (!client) {
        log.info({ count: messages.length }, 'batch email send skipped (no RESEND_API_KEY)');
        return { skipped: true };
    }
    // Resend's batch endpoint accepts up to 100 per call.
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));
    const results = [];
    for (const chunk of chunks) {
        const payload = chunk.map((m) => ({
            from: FROM,
            to: m.to,
            subject: m.subject,
            html: render(loadTemplate(m.template), m.data),
        }));
        try {
            const r = await client.batch.send(payload);
            results.push(r);
        } catch (err) {
            log.error({ err, chunkSize: chunk.length }, 'batch send chunk failed');
            // Continue with remaining chunks rather than aborting the entire alert run.
        }
    }
    log.info({ totalSent: messages.length }, 'batch email run complete');
    return results;
}

module.exports = { send, sendBatch };
