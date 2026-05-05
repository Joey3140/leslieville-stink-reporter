// One-shot migration: re-encrypt any subscriber rows whose `email` is still
// plaintext (pre-encryption rollout). Idempotent — rows already carrying the
// `v1:` prefix are skipped.
//
// Usage:
//   SUBSCRIBER_EMAIL_KEY=<64-hex-chars> \
//   FIREBASE_SERVICE_ACCOUNT='<json>' \
//   node scripts/migrate-encrypt-emails.js
//
// Reads from .env if present, so a normal local shell with the dev .env loaded
// will work too.
require('dotenv').config();
const admin = require('firebase-admin');
const { encryptEmail, isEncryptedEmail } = require('../utils/email-crypto');

if (!process.env.SUBSCRIBER_EMAIL_KEY) {
    console.error('SUBSCRIBER_EMAIL_KEY not set. Generate one with:');
    console.error('  node -e \'console.log(require("crypto").randomBytes(32).toString("hex"))\'');
    process.exit(1);
}

function initFirebase() {
    if (admin.apps.length) return;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(sa) });
    } else {
        admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
}

(async function main() {
    initFirebase();
    const dbId = process.env.FIRESTORE_DATABASE_ID || '(default)';
    const db = dbId === '(default)'
        ? admin.firestore()
        : admin.firestore(admin.app(), dbId);

    const snap = await db.collection('subscribers').get();
    let migrated = 0, skippedEncrypted = 0, skippedEmpty = 0;
    const updates = [];
    for (const doc of snap.docs) {
        const email = doc.data().email;
        if (!email) { skippedEmpty += 1; continue; }
        if (isEncryptedEmail(email)) { skippedEncrypted += 1; continue; }
        updates.push({ ref: doc.ref, value: encryptEmail(email) });
    }
    // Firestore batch limit is 500 ops; chunk to be safe.
    for (let i = 0; i < updates.length; i += 400) {
        const batch = db.batch();
        for (const u of updates.slice(i, i + 400)) {
            batch.update(u.ref, { email: u.value });
            migrated += 1;
        }
        await batch.commit();
    }
    console.log(`done. migrated=${migrated} alreadyEncrypted=${skippedEncrypted} empty=${skippedEmpty} total=${snap.size}`);
    process.exit(0);
})().catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
});
