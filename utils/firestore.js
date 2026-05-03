const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { createChild } = require('./logger');

const log = createChild('firestore');

// FIRESTORE_DATABASE_ID supports named databases. Leave unset (or "(default)")
// to use the default database. Using a named database avoids accidentally
// hitting the wrong DB if a project has more than one.
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
let cachedDb = null;

function getDb() {
    if (cachedDb) return cachedDb;
    if (admin.apps.length === 0) return null;
    cachedDb = DATABASE_ID === '(default)'
        ? getFirestore(admin.app())
        : getFirestore(admin.app(), DATABASE_ID);
    log.info({ databaseId: DATABASE_ID }, 'Firestore client initialized');
    return cachedDb;
}

function requireDb() {
    const db = getDb();
    if (!db) {
        log.error('Firestore unavailable — Firebase Admin not initialized');
        throw new Error('Firestore unavailable');
    }
    return db;
}

const COLLECTIONS = {
    reports: 'reports',
    dailyCounts: 'daily-counts',
    subscribers: 'subscribers',
    alertState: 'fsa-alert-state',
    alertCounters: 'alert-counters',
    rateLimits: 'rate-limits',
};

module.exports = { getDb, requireDb, COLLECTIONS, FieldValue: admin.firestore.FieldValue };
