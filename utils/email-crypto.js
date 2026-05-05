// AES-256-GCM encryption for subscriber emails at rest.
//
// Threat model: a leaked Firestore export, a compromised service account, or
// insider read access to the database — without the SUBSCRIBER_EMAIL_KEY env
// var, the email column is opaque ciphertext. Does NOT protect against a
// compromised Vercel runtime (the key sits in process memory there).
//
// Storage format: `v1:<base64(nonce(12) || ciphertext(N) || tag(16))>`. The
// `v1:` prefix lets us key-rotate later by adding a `v2:` decrypt path while
// still being able to read existing rows.
//
// Backward compatibility: decryptEmail() returns plaintext unchanged if it
// doesn't carry the version prefix, so legacy rows from before this rollout
// keep working until the migration script runs.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_PREFIX = 'v1:';

let cachedKey = null;

function getKey() {
    if (cachedKey) return cachedKey;
    const raw = process.env.SUBSCRIBER_EMAIL_KEY;
    if (!raw) {
        throw new Error('SUBSCRIBER_EMAIL_KEY env var is required for subscriber email encryption');
    }
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== KEY_BYTES) {
        throw new Error(`SUBSCRIBER_EMAIL_KEY must be ${KEY_BYTES * 2} hex characters (got ${raw.length})`);
    }
    cachedKey = buf;
    return cachedKey;
}

function encryptEmail(plaintext) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new Error('encryptEmail expects a non-empty string');
    }
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(ALGO, getKey(), nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return VERSION_PREFIX + Buffer.concat([nonce, ct, tag]).toString('base64');
}

function decryptEmail(stored) {
    if (typeof stored !== 'string' || stored.length === 0) return null;
    // Legacy plaintext rows (pre-encryption) pass through unchanged. The migration
    // script rewrites these in-place; once it has run, every row carries the prefix.
    if (!stored.startsWith(VERSION_PREFIX)) return stored;
    const blob = Buffer.from(stored.slice(VERSION_PREFIX.length), 'base64');
    if (blob.length < NONCE_BYTES + TAG_BYTES) {
        throw new Error('decryptEmail: ciphertext too short to contain nonce + tag');
    }
    const nonce = blob.subarray(0, NONCE_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const ct = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function isEncryptedEmail(stored) {
    return typeof stored === 'string' && stored.startsWith(VERSION_PREFIX);
}

module.exports = { encryptEmail, decryptEmail, isEncryptedEmail };
