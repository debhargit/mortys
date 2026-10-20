// =============================================================================
//  Vision Auto Solutions -- minimal WebAuthn (passkeys) verifier
//
//  Used by timeclock.js for fingerprint / face clock-in. The browser and the
//  device (Windows Hello, a phone's fingerprint or face unlock) do the
//  biometric check; the fingerprint never leaves the device. We keep only the
//  public key of the passkey and check signatures with it.
//
//  Scope: attestation 'none' (we trust the device the shop enrols, we do not
//  check who made it), ES256 and RS256 keys, user verification required.
//  No library: a small CBOR reader and Node's crypto.
// =============================================================================
'use strict';

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// CBOR, just enough for attestation objects and COSE keys.
function cbor(buf, pos) {
  pos = pos || 0;
  const head = buf[pos++];
  const major = head >> 5, info = head & 31;
  let len = info;
  if (info === 24) { len = buf[pos]; pos += 1; }
  else if (info === 25) { len = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { len = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
  else if (info > 27) throw new Error('Unsupported CBOR');
  switch (major) {
    case 0: return { value: len, pos };
    case 1: return { value: -1 - len, pos };
    case 2: return { value: buf.slice(pos, pos + len), pos: pos + len };
    case 3: return { value: buf.slice(pos, pos + len).toString('utf8'), pos: pos + len };
    case 4: { const arr = []; for (let i = 0; i < len; i++) { const r = cbor(buf, pos); arr.push(r.value); pos = r.pos; } return { value: arr, pos }; }
    case 5: { const map = new Map(); for (let i = 0; i < len; i++) { const k = cbor(buf, pos); const v = cbor(buf, k.pos); map.set(k.value, v.value); pos = v.pos; } return { value: map, pos }; }
    case 7: return { value: info === 20 ? false : info === 21 ? true : null, pos };
    default: throw new Error('Unsupported CBOR type');
  }
}

function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('Authenticator data too short');
  const out = { rpIdHash: ad.slice(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01); out.uv = !!(out.flags & 0x04); out.at = !!(out.flags & 0x40);
  if (out.at) {
    let p = 37 + 16;                                   // skip AAGUID
    const idLen = ad.readUInt16BE(p); p += 2;
    out.credentialId = ad.slice(p, p + idLen); p += idLen;
    out.coseKey = cbor(ad, p).value;
  }
  return out;
}

// COSE key -> JWK (EC2 P-256 / ES256, RSA / RS256).
function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) return { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) };
  if (kty === 3 && alg === -257) return { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)) };
  throw new Error('This device uses a key type the shop does not support');
}

function checkClient(clientDataJSON, type, challenge, origins) {
  const c = JSON.parse(fromB64u(clientDataJSON).toString('utf8'));
  if (c.type !== type) throw new Error('Wrong ceremony');
  if (c.challenge !== challenge) throw new Error('This request is out of date: try again');
  if (!origins.includes(c.origin)) throw new Error('Signed for a different site (' + c.origin + ')');
  return c;
}

const newChallenge = () => b64u(crypto.randomBytes(32));

// Registration response from navigator.credentials.create().
function verifyRegistration(cred, { challenge, origins, rpId }) {
  if (!cred || !cred.response) throw new Error('No credential');
  checkClient(cred.response.clientDataJSON, 'webauthn.create', challenge, origins);
  const att = cbor(fromB64u(cred.response.attestationObject)).value;
  const ad = parseAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Registered for a different site');
  if (!ad.up || !ad.uv) throw new Error('The fingerprint / face check did not happen');
  if (!ad.credentialId || !ad.coseKey) throw new Error('No key in the response');
  return { credentialId: b64u(ad.credentialId), jwk: coseToJwk(ad.coseKey), signCount: ad.signCount };
}

// Assertion from navigator.credentials.get(); stored = {jwk, sign_count}.
function verifyAssertion(cred, stored, { challenge, origins, rpId }) {
  if (!cred || !cred.response) throw new Error('No credential');
  const cdj = fromB64u(cred.response.clientDataJSON);
  checkClient(cred.response.clientDataJSON, 'webauthn.get', challenge, origins);
  const authData = fromB64u(cred.response.authenticatorData);
  const ad = parseAuthData(authData);
  if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Signed for a different site');
  if (!ad.up || !ad.uv) throw new Error('The fingerprint / face check did not happen');
  const key = crypto.createPublicKey({ key: stored.jwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.concat([authData, sha256(cdj)]), key, fromB64u(cred.response.signature));
  if (!ok) throw new Error('The signature does not match');
  // A counter that goes backwards means a copied key; 0 means the device does not count.
  if (ad.signCount !== 0 && Number(stored.sign_count) !== 0 && ad.signCount <= Number(stored.sign_count)) throw new Error('This passkey looks copied: ask a manager');
  return { signCount: ad.signCount };
}

module.exports = { newChallenge, verifyRegistration, verifyAssertion, b64u, fromB64u, _cbor: cbor, _coseToJwk: coseToJwk, _parseAuthData: parseAuthData };
