// Membuat pasangan kunci VAPID (P-256). Jalankan: node scripts/gen-vapid.mjs
// PUBLIC -> js/config.js (VAPID_PUBLIC_KEY) dan secret VAPID_PUBLIC_KEY. PRIVATE -> hanya secret Edge Function. Jangan commit yang private.
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + pub);
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
console.log('PUSH_WEBHOOK_SECRET=' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'));
