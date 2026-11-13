// Cron routes: Vercel Cron calls each path with GET plus
// `Authorization: Bearer $CRON_SECRET`, so both paths must answer GET behind
// cronAuth. Firestore and Resend are replaced with in-memory fakes so this
// runs offline: `npm test`.
process.env.NODE_ENV = 'test';
process.env.CRON_SECRET = 'test-cron-secret-not-real-0123456789abcdef';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const SECRET = process.env.CRON_SECRET;

// ---- fakes -----------------------------------------------------------------

let state;
function resetState() {
    state = {
        docs: {},        // `${collection}/${id}` -> data
        lists: {},       // collection -> [data with id]
        writes: [],      // { col, id, data }
        sendResult: { sent: 0, failed: 0 },
        sendCalls: 0,
    };
}

function snapOf(docs) {
    return {
        docs: docs.map((d) => ({ id: d.id, ref: { col: d.col, id: d.id }, data: () => d })),
        empty: docs.length === 0,
        size: docs.length,
    };
}

function query(col, filters = []) {
    const q = {
        where: (field, op, value) => query(col, op === '==' ? [...filters, [field, value]] : filters),
        select: () => q,
        limit: () => q,
        get: async () => snapOf((state.lists[col] || [])
            .filter((d) => filters.every(([f, v]) => d[f] === v || (Array.isArray(d[f]) && d[f].includes(v))))),
    };
    return q;
}

const fakeDb = {
    collection: (col) => ({
        ...query(col),
        doc: (id) => ({
            get: async () => {
                const data = state.docs[`${col}/${id}`];
                return { exists: data !== undefined, data: () => data };
            },
            set: async (data) => { state.writes.push({ col, id, data }); },
        }),
    }),
    batch: () => ({ delete: () => {}, commit: async () => {} }),
};

function stub(relPath, exportsObj) {
    const file = require.resolve(path.join(__dirname, '..', relPath));
    require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

stub('utils/firestore.js', {
    requireDb: () => fakeDb,
    getDb: () => fakeDb,
    COLLECTIONS: {
        reports: 'reports', subscribers: 'subscribers', alertState: 'fsa-alert-state',
        alertCounters: 'alert-counters', rateLimits: 'rate-limits',
    },
    FieldValue: { increment: (n) => ({ increment: n }) },
});
stub('utils/email.js', {
    send: async () => ({}),
    sendBatch: async () => { state.sendCalls += 1; return state.sendResult; },
});
stub('utils/email-crypto.js', { decryptEmail: (v) => v, encryptEmail: (v) => v });

// ---- app -------------------------------------------------------------------

let server;
let base;
before(async () => {
    const app = express();
    app.use('/api/cron', require('../routes/alerts'));
    app.use((req, res) => res.status(404).json({ error: 'Not found' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(resetState);

const call = (p, { method = 'GET', token } = {}) => fetch(`${base}${p}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
});

// One subscriber in M4M and ten severe reports in the last hour: crosses both
// thresholds (10 reports, average severity >= 3) with no cooldown on file.
function seedTriggeredAlert() {
    state.lists.subscribers = [{
        id: 'sub1', col: 'subscribers', status: 'active', fsas: ['M4M'],
        email: 'v1:ciphertext', emailHash: 'hash1', thresholdSeverity: 3, unsubscribeToken: 'tok',
    }];
    state.lists.reports = Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`, col: 'reports', status: 'active', fsa: 'M4M', severity: 5, odourType: 'sewage',
    }));
}

// ---- GET, the way Vercel Cron calls -----------------------------------------

for (const route of ['/api/cron/alert-check', '/api/cron/prune-rate-limits']) {
    test(`GET ${route} with the cron secret is accepted`, async () => {
        const res = await call(route, { token: SECRET });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).ok, true);
    });

    test(`GET ${route} without a token is refused`, async () => {
        const res = await call(route);
        assert.equal(res.status, 401);
    });

    test(`GET ${route} with the wrong token is refused`, async () => {
        const res = await call(route, { token: 'wrong-token-of-the-same-length-0123456789ab' });
        assert.equal(res.status, 401);
    });

    test(`POST ${route} still works for manual runs`, async () => {
        assert.equal((await call(route, { method: 'POST', token: SECRET })).status, 200);
        assert.equal((await call(route, { method: 'POST' })).status, 401);
    });
}

// ---- send failures must not start the cooldown --------------------------------

test('a fully failed send leaves the FSA out of cooldown and answers 502', async () => {
    seedTriggeredAlert();
    state.sendResult = { sent: 0, failed: 1 };
    const res = await call('/api/cron/alert-check', { token: SECRET });
    assert.equal(state.sendCalls, 1);
    assert.equal(res.status, 502);
    assert.deepEqual(state.writes, [], 'no cooldown or counter write after a failed send');
});

test('a successful send starts the cooldown and bumps the daily counter', async () => {
    seedTriggeredAlert();
    state.sendResult = { sent: 1, failed: 0 };
    const res = await call('/api/cron/alert-check', { token: SECRET });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sent, 1);
    assert.ok(state.writes.some((w) => w.col === 'fsa-alert-state' && w.id === 'M4M'));
    const counter = state.writes.find((w) => w.col === 'alert-counters');
    assert.deepEqual(counter.data.sentToday, { increment: 1 });
});
