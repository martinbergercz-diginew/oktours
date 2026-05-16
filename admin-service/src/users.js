// User store — disk-backed JSON, the same pattern as sessions/drafts.
// Two roles: "admin" (can manage users) and "editor". Both can edit and
// publish the site. Passwords are scrypt-hashed; reset tokens are stored
// hashed with a short expiry. Sized for a handful of users.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hashPassword, verifyPassword } from "./auth.js";

const USERS_FILE = path.join(process.env.DATA_DIR || "./data", "users.json");

export const ROLES = ["admin", "editor"];
const MIN_PASSWORD_LEN = 8;
const RESET_TTL_MS = 60 * 60 * 1000;          // 1 hour
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;         // 15 minutes

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    cache = { users: [], resetTokens: [] };
  }
  if (!Array.isArray(cache.users)) cache.users = [];
  if (!Array.isArray(cache.resetTokens)) cache.resetTokens = [];
  return cache;
}

async function persist() {
  await fs.mkdir(path.dirname(USERS_FILE), { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(cache, null, 2));
}

// Serialize mutations so overlapping admin actions can't lose a write.
let opChain = Promise.resolve();
function serialize(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.then(() => {}, () => {});
  return run;
}

// --- helpers ----------------------------------------------------------

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt };
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// --- queries ----------------------------------------------------------

export async function listUsers() {
  const db = await load();
  return db.users.map(publicUser).sort((a, b) => a.email.localeCompare(b.email));
}

export async function findById(id) {
  const db = await load();
  return db.users.find(u => u.id === id) || null;
}

export async function findByEmail(email) {
  const db = await load();
  const e = normalizeEmail(email);
  return db.users.find(u => u.email === e) || null;
}

async function countAdmins() {
  const db = await load();
  return db.users.filter(u => u.role === "admin").length;
}

// --- mutations --------------------------------------------------------

/** Create the first admin from env on a fresh install. No-op if users exist. */
export async function seedFirstAdmin({ email, password }) {
  return serialize(async () => {
    const db = await load();
    if (db.users.length > 0) return { seeded: false };
    if (!email || !password) return { seeded: false, reason: "no-env" };
    const e = normalizeEmail(email);
    db.users.push({
      id: crypto.randomUUID(),
      email: e,
      role: "admin",
      passwordHash: hashPassword(password),
      credentialVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await persist();
    return { seeded: true, email: e };
  });
}

export async function createUser({ email, role, password }) {
  return serialize(async () => {
    const db = await load();
    const e = normalizeEmail(email);
    if (!isValidEmail(e)) throw new Error("Neplatná e-mailová adresa.");
    if (!ROLES.includes(role)) throw new Error("Neplatná role.");
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
      throw new Error(`Heslo musí mít alespoň ${MIN_PASSWORD_LEN} znaků.`);
    }
    if (db.users.some(u => u.email === e)) throw new Error("Uživatel s tímto e-mailem už existuje.");
    const user = {
      id: crypto.randomUUID(),
      email: e,
      role,
      passwordHash: hashPassword(password),
      credentialVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.users.push(user);
    await persist();
    return publicUser(user);
  });
}

export async function setPassword(id, newPassword) {
  return serialize(async () => {
    const db = await load();
    const user = db.users.find(u => u.id === id);
    if (!user) throw new Error("Uživatel nenalezen.");
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LEN) {
      throw new Error(`Heslo musí mít alespoň ${MIN_PASSWORD_LEN} znaků.`);
    }
    user.passwordHash = hashPassword(newPassword);
    user.credentialVersion += 1;                 // invalidates existing sessions
    user.updatedAt = new Date().toISOString();
    // Any outstanding reset tokens for this user are now spent.
    db.resetTokens = db.resetTokens.filter(t => t.userId !== id);
    await persist();
    return publicUser(user);
  });
}

export async function setRole(id, role) {
  return serialize(async () => {
    const db = await load();
    const user = db.users.find(u => u.id === id);
    if (!user) throw new Error("Uživatel nenalezen.");
    if (!ROLES.includes(role)) throw new Error("Neplatná role.");
    if (user.role === "admin" && role !== "admin"
        && db.users.filter(u => u.role === "admin").length <= 1) {
      throw new Error("Nelze odebrat poslední administrátorský účet.");
    }
    user.role = role;
    user.updatedAt = new Date().toISOString();
    await persist();
    return publicUser(user);
  });
}

export async function deleteUser(id) {
  return serialize(async () => {
    const db = await load();
    const user = db.users.find(u => u.id === id);
    if (!user) throw new Error("Uživatel nenalezen.");
    if (user.role === "admin" && db.users.filter(u => u.role === "admin").length <= 1) {
      throw new Error("Nelze smazat poslední administrátorský účet.");
    }
    db.users = db.users.filter(u => u.id !== id);
    db.resetTokens = db.resetTokens.filter(t => t.userId !== id);
    await persist();
    return { deleted: true };
  });
}

// --- login + throttle -------------------------------------------------

const throttle = new Map();   // email → { fails, lockedUntil }

export function loginLockRemainingMs(email) {
  const e = throttle.get(normalizeEmail(email));
  if (!e || !e.lockedUntil) return 0;
  return Math.max(0, e.lockedUntil - Date.now());
}

function recordFail(email) {
  const e = normalizeEmail(email);
  const cur = throttle.get(e) || { fails: 0, lockedUntil: 0 };
  cur.fails += 1;
  if (cur.fails >= MAX_LOGIN_FAILS) cur.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  throttle.set(e, cur);
}

/** Verify an email+password login. Returns { ok, user?, lockedMs? }. */
export async function verifyLogin(email, password) {
  const lockedMs = loginLockRemainingMs(email);
  if (lockedMs > 0) return { ok: false, lockedMs };
  const user = await findByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    recordFail(email);
    return { ok: false };
  }
  throttle.delete(normalizeEmail(email));
  return { ok: true, user };
}

// --- password reset tokens -------------------------------------------

export async function createResetToken(userId) {
  return serialize(async () => {
    const db = await load();
    const raw = crypto.randomBytes(32).toString("hex");
    db.resetTokens = db.resetTokens.filter(t => t.expiresAt > Date.now());
    db.resetTokens.push({ userId, tokenHash: sha256(raw), expiresAt: Date.now() + RESET_TTL_MS });
    await persist();
    return raw;
  });
}

/** Consume a reset token. Returns the userId, or null if invalid/expired. */
export async function consumeResetToken(raw) {
  return serialize(async () => {
    const db = await load();
    const h = sha256(String(raw || ""));
    const idx = db.resetTokens.findIndex(t => t.tokenHash === h && t.expiresAt > Date.now());
    if (idx === -1) {
      db.resetTokens = db.resetTokens.filter(t => t.expiresAt > Date.now());
      await persist();
      return null;
    }
    const { userId } = db.resetTokens[idx];
    db.resetTokens.splice(idx, 1);
    await persist();
    return userId;
  });
}
