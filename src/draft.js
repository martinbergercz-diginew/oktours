// In-memory draft store. Holds pending file writes/deletes for a session
// until the client confirms. Persisted to disk so a server restart
// mid-confirmation doesn't lose the draft.

import fs from "node:fs/promises";
import path from "node:path";

const DRAFT_DIR = process.env.DATA_DIR || "./data";

function draftPath(sessionId) {
  return path.join(DRAFT_DIR, `draft-${sessionId}.json`);
}

export async function loadDraft(sessionId) {
  try {
    const raw = await fs.readFile(draftPath(sessionId), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return emptyDraft();
    throw err;
  }
}

export function emptyDraft() {
  return {
    writes: {},      // relative path → new content
    deletes: [],     // relative paths
    summary_cs: "",
    affected_pages: [],
    is_destructive: false,
    language_scope: null,
    awaiting_confirmation: false,
    created_at: null,
  };
}

export async function saveDraft(sessionId, draft) {
  await fs.mkdir(DRAFT_DIR, { recursive: true });
  await fs.writeFile(draftPath(sessionId), JSON.stringify(draft, null, 2));
}

export async function clearDraft(sessionId) {
  try {
    await fs.unlink(draftPath(sessionId));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export function isDraftEmpty(draft) {
  return Object.keys(draft.writes).length === 0 && draft.deletes.length === 0;
}
