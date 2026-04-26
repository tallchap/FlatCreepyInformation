#!/usr/bin/env node
// Encrypt a secret with AES-256-GCM, key = SHA-256(EXPENSES_TOKEN_PLAINTEXT).
// Usage:
//   node scripts/encrypt-secret.mjs "<expenses_token>" "<plaintext_secret>"
//
// The output base64 string can be pasted as the *_ENC_B64 constant in
// src/app/api/expenses/route.ts. Decryption happens at request time using
// the user's ?key=... query param.

import { webcrypto as crypto } from "node:crypto";

const [, , userKey, plaintext] = process.argv;
if (!userKey || !plaintext) {
  console.error('usage: node scripts/encrypt-secret.mjs "<expenses_token>" "<plaintext_secret>"');
  process.exit(1);
}

const iv = crypto.getRandomValues(new Uint8Array(12));
const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userKey));
const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
const ct = new Uint8Array(
  await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
);
const blob = new Uint8Array(iv.length + ct.length);
blob.set(iv, 0);
blob.set(ct, iv.length);
console.log(Buffer.from(blob).toString("base64"));
