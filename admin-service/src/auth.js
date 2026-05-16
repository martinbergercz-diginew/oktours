// Authentication primitives: password hashing and signed session cookies.
//
// Users log in with email + password (see src/users.js for the store).
// On success they get an HttpOnly, HMAC-signed session cookie that
// carries their user id and a credential version — bumping that version
// (on a password change/reset) instantly invalidates old sessions.

import crypto from "node:crypto";

export const COOKIE_NAME = "oktours_admin_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- cookie-signing secret -------------------------------------------

let _devSecret = null;
let _warnedDevSecret = false;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (typeof s === "string" && s.length >= 16) return s;
  if (!_warnedDevSecret) {
    console.warn("[auth] SESSION_SECRET not set — using an ephemeral dev secret (sessions reset on restart).");
    _warnedDevSecret = true;
  }
  _devSecret ||= crypto.randomBytes(32).toString("hex");
  return _devSecret;
}

// --- password hashing (scrypt, no external dependency) ---------------

export function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 1) {
    throw new Error("Heslo nesmí být prázdné.");
  }
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(plain, salt, 32);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  let dk;
  try { dk = crypto.scryptSync(plain, salt, expected.length); }
  catch { return false; }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// --- session token: base64url(payload).hmac --------------------------

function sign(body) {
  return crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
}

/** Issue a session token for a user. cv = credentialVersion at issue time. */
export function issueToken(user) {
  const now = Date.now();
  const payload = { uid: user.id, cv: user.credentialVersion, iat: now, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Verify signature + expiry. Returns the payload object, or null. */
export function readToken(token) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || Date.now() >= payload.exp) return null;
    if (typeof payload.uid !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

// --- cookie helpers --------------------------------------------------

export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure }) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie({ secure }) {
  const attrs = [`${COOKIE_NAME}=`, "Path=/admin", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
