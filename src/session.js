// Session store. Single shared session for MVP (one client), but keyed by
// sessionId so we can add multiple users in v2 without restructuring.
// Persists chat history to disk so the client can close the browser and
// resume tomorrow with full context (§3 — Resume from a prior session).

import fs from "node:fs/promises";
import path from "node:path";

const SESSIONS_FILE = path.join(process.env.DATA_DIR || "./data", "sessions.json");
const MAX_TURNS = 50;
const DEFAULT_SESSION_ID = "shared";

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf8");
    cache = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    cache = {};
  }
  return cache;
}

async function persist() {
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(cache, null, 2));
}

export async function getSession(sessionId = DEFAULT_SESSION_ID) {
  const all = await load();
  if (!all[sessionId]) {
    all[sessionId] = {
      sessionId,
      messages: [],   // Anthropic-format messages (user/assistant turns)
      uiLog: [],      // UI-format log (text + button states) for replay
      counters: { commits_today: 0, publishes_today: 0, day: today() },
      created_at: new Date().toISOString(),
    };
    await persist();
  }
  return all[sessionId];
}

export async function appendMessage(sessionId, message) {
  const session = await getSession(sessionId);
  session.messages.push(message);
  // Keep tail of MAX_TURNS user+assistant pairs.
  if (session.messages.length > MAX_TURNS * 2) {
    session.messages = session.messages.slice(-MAX_TURNS * 2);
  }
  await persist();
}

export async function appendUiEntry(sessionId, entry) {
  const session = await getSession(sessionId);
  session.uiLog.push({ ...entry, at: new Date().toISOString() });
  if (session.uiLog.length > 200) session.uiLog = session.uiLog.slice(-200);
  await persist();
}

export async function bumpCounter(sessionId, kind) {
  const session = await getSession(sessionId);
  if (session.counters.day !== today()) {
    session.counters = { commits_today: 0, publishes_today: 0, day: today() };
  }
  session.counters[kind] = (session.counters[kind] || 0) + 1;
  await persist();
  return session.counters[kind];
}

export async function checkRateLimit(sessionId, kind, max) {
  const session = await getSession(sessionId);
  if (session.counters.day !== today()) return true;
  return (session.counters[kind] || 0) < max;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
