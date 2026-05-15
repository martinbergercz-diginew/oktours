// Shared-password login for the admin UI.
//
// The client logs in once at /admin/login with a shared password
// (ADMIN_PASSWORD). On success we hand back an HttpOnly, signed session
// cookie; every /admin request after that is checked against it.
//
// No database, no user accounts — single shared login, per the spec
// (ADMIN_CHAT_SPEC.md §2: "Single shared login").
//
// The cookie is a stateless HMAC-signed token: base64url(payload).signature.
// No server-side session store, so it survives restarts as long as
// SESSION_SECRET is stable.

import crypto from "node:crypto";

export const COOKIE_NAME = "oktours_admin_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- secret -----------------------------------------------------------

let _devSecret = null;
let _warnedDevSecret = false;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (typeof s === "string" && s.length >= 16) return s;
  // Dev fallback: a per-process random secret. Sessions won't survive a
  // restart, but local dev doesn't care. Production sets SESSION_SECRET
  // explicitly (server.js fails fast if it's missing in prod).
  if (!_warnedDevSecret) {
    console.warn("[auth] SESSION_SECRET not set — using an ephemeral dev secret (sessions reset on restart).");
    _warnedDevSecret = true;
  }
  _devSecret ||= crypto.randomBytes(32).toString("hex");
  return _devSecret;
}

// --- password ---------------------------------------------------------

export function isAuthConfigured() {
  return typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0;
}

export function checkPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal length; length itself isn't secret here.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- token sign / verify ---------------------------------------------

function sign(body) {
  return crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
}

export function issueToken() {
  const now = Date.now();
  const payload = { iat: now, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyToken(token) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

// --- cookie helpers ---------------------------------------------------

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

/** True if the request carries a valid session cookie. */
export function isRequestAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}
