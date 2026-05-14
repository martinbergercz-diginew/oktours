// Fastify server. Static UI + JSON API endpoints.
// See ../ADMIN_CHAT_SPEC.md §4 for the endpoint contract.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { runTurn } from "./agent.js";
import { GitOps } from "./ops/git-ops.js";
import { smokeCheck } from "./ops/smoke.js";
import { notifyPublish } from "./ops/mailer.js";
import { handleUpload } from "./ops/upload.js";
import { loadDraft, saveDraft, clearDraft, emptyDraft, isDraftEmpty } from "./draft.js";
import {
  getSession, appendMessage, appendUiEntry, bumpCounter, checkRateLimit, resetMessages,
} from "./session.js";
import { UploadsStore } from "./uploads-store.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DRY_RUN = process.env.DRY_RUN === "true";

// Default to local dev paths if env vars unset.
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
process.env.DATA_DIR = dataDir;
await fs.mkdir(dataDir, { recursive: true });

const REPO_PATH = process.env.REPO_PATH || path.resolve(__dirname, "..", "..", "..");
const STAGING_PATH = process.env.STAGING_PATH || path.join(dataDir, "dev-staging");
const SHADOW_PATH = process.env.SHADOW_PATH || path.join(dataDir, "dev-shadow");
const LIVE_PATH = process.env.LIVE_PATH || path.join(dataDir, "dev-live");
const PREVIOUS_PATH = process.env.PREVIOUS_PATH || path.join(dataDir, "dev-previous");

// Make sure the deploy target dirs exist so fastify-static can mount them.
for (const p of [STAGING_PATH, SHADOW_PATH, LIVE_PATH, PREVIOUS_PATH]) {
  await fs.mkdir(p, { recursive: true });
}

const STAGING_URL = process.env.STAGING_URL || `http://localhost:${PORT}/_staging`;
const LIVE_URL = process.env.LIVE_URL || `http://localhost:${PORT}/_live`;

const gitOps = new GitOps({
  repoRoot: REPO_PATH,
  stagingPath: STAGING_PATH,
  shadowPath: SHADOW_PATH,
  livePath: LIVE_PATH,
  previousPath: PREVIOUS_PATH,
  dryRun: DRY_RUN,
});

const uploadsStore = new UploadsStore();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || "info" },
  bodyLimit: 25 * 1024 * 1024,
});

// Static UI served at /admin/* (Caddy will reverse-proxy here).
await fastify.register(fastifyStatic, {
  root: path.resolve(__dirname, "..", "public"),
  prefix: "/admin/",
});

// In local dev only — serve staging + live deploy targets directly so the
// developer can preview without Caddy.
if (DRY_RUN) {
  await fastify.register(fastifyStatic, {
    root: STAGING_PATH,
    prefix: "/_staging/",
    decorateReply: false,
  });
  await fastify.register(fastifyStatic, {
    root: LIVE_PATH,
    prefix: "/_live/",
    decorateReply: false,
  });
}

// Health.
fastify.get("/admin/api/health", async () => ({
  ok: true, dryRun: DRY_RUN, repo: REPO_PATH, version: "0.1.0",
}));

// Session bootstrap — returns chat history + pending state for resume.
fastify.get("/admin/api/session", async () => {
  const session = await getSession();
  const draft = await loadDraft(session.sessionId);
  let staging = null;
  try {
    const ahead = await gitOps.stagingAheadOfMain();
    if (ahead > 0) {
      const head = (await gitOps.git.revparse(["HEAD"])).trim();
      staging = { commit: head, ahead };
    }
  } catch (err) {
    fastify.log.warn({ err }, "Could not read staging state");
  }
  return {
    sessionId: session.sessionId,
    uiLog: session.uiLog,
    counters: session.counters,
    draft: draft.awaiting_confirmation ? {
      summary_cs: draft.summary_cs,
      is_destructive: draft.is_destructive,
      affected_pages: draft.affected_pages,
    } : null,
    stagingCommit: staging?.commit || null,
    stagingAhead: staging?.ahead || 0,
    stagingUrl: STAGING_URL,
    liveUrl: LIVE_URL,
  };
});

// Chat — runs one Claude turn.
fastify.post("/admin/api/chat", async (req, reply) => {
  const { text, squashChoice } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    return reply.code(400).send({ error: "text required" });
  }

  const session = await getSession();
  let draft = await loadDraft(session.sessionId);
  const systemAdditions = [];

  // §3.2 squash-on-second-turn: if staging already has an unpublished
  // commit AND no current draft, the client is starting a NEW edit while
  // staging is dirty. We surface the choice in the UI first.
  const stagingAhead = await gitOps.stagingAheadOfMain().catch(() => 0);
  if (stagingAhead > 0 && !draft.awaiting_confirmation && isDraftEmpty(draft)) {
    if (!squashChoice) {
      return reply.send({
        kind: "squash_prompt",
        text: "Máš na náhledu neuveřejněnou úpravu. Chceš novou změnu přibalit k té stávající, nebo nejdřív tu starou zrušit?",
        buttons: ["bundle", "undo_previous"],
      });
    }
    if (squashChoice === "undo_previous") {
      await gitOps.undoStaging();
      await appendUiEntry(session.sessionId, { kind: "system", text: "Předchozí náhled zrušen." });
    }
    // 'bundle' falls through; the draft starts empty, gets applied as amend.
  }

  // Push uploads-pending into the system prompt.
  const pending = await uploadsStore.list();
  if (pending.length) {
    const list = pending.map(u => `- ${u.path} (${u.kind}, ${u.size_kb} KB, "${u.original_name}")`).join("\n");
    systemAdditions.push(`Klient nedávno nahrál tyto soubory (24h TTL):\n${list}\nPokud jsou relevantní k požadavku, použij je.`);
  }

  let turnResult;
  try {
    turnResult = await runTurn({
      userMessage: text,
      session,
      draft,
      repoRoot: path.join(REPO_PATH, ""),
      uploadsStore,
      systemAdditions,
    });
  } catch (err) {
    if (err.code === "BUDGET_EXCEEDED") {
      await clearDraft(session.sessionId);
      const detail = err.budgetKind ? ` (${err.budgetKind} > ${err.budgetLimit})` : "";
      fastify.log.warn({ kind: err.budgetKind, limit: err.budgetLimit }, "Per-turn budget exceeded");
      return reply.send({
        kind: "error",
        text: `Tahle změna byla moc velká na jeden krok${detail}. Zkus ji rozdělit na menší kousky, nebo napiš Martinovi.`,
      });
    }
    fastify.log.error({ err }, "Chat turn failed");
    return reply.code(500).send({ error: err.message });
  }

  // Persist updated session messages and draft.
  session.messages = turnResult.messages;
  await appendMessage(session.sessionId, { role: "user", content: text });   // index log
  await saveDraft(session.sessionId, draft);
  await appendUiEntry(session.sessionId, { kind: "user", text });
  await appendUiEntry(session.sessionId, { kind: "assistant", text: turnResult.assistantText });

  // If the agent reached propose_change, surface the confirmation buttons.
  if (turnResult.proposeResult) {
    return reply.send({
      kind: "confirm_prompt",
      text: turnResult.assistantText,
      summary_cs: turnResult.proposeResult.summary_cs,
      is_destructive: turnResult.proposeResult.is_destructive,
      affected_pages: turnResult.proposeResult.affected_pages,
      budget: turnResult.budget,
    });
  }

  return reply.send({
    kind: "plain",
    text: turnResult.assistantText,
    budget: turnResult.budget,
  });
});

// Confirm — client clicked "Yes, apply". Commits the draft to staging.
fastify.post("/admin/api/confirm", async (req, reply) => {
  const session = await getSession();
  const draft = await loadDraft(session.sessionId);
  if (!draft.awaiting_confirmation) {
    return reply.code(400).send({ error: "No draft awaiting confirmation." });
  }
  if (!(await checkRateLimit(session.sessionId, "commits_today", 30))) {
    return reply.code(429).send({ error: "Denní limit úprav vyčerpán (30/den)." });
  }

  try {
    await gitOps.ensureBranches();
    const { commit } = await gitOps.applyDraftToStaging(draft);
    await bumpCounter(session.sessionId, "commits_today");
    await clearDraft(session.sessionId);
    await appendUiEntry(session.sessionId, {
      kind: "staged",
      commit,
      summary: draft.summary_cs,
      stagingUrl: STAGING_URL,
    });
    return reply.send({
      kind: "staged",
      commit,
      stagingUrl: STAGING_URL,
      text: `Hotovo. Náhled máš zde: ${STAGING_URL}`,
    });
  } catch (err) {
    fastify.log.error({ err }, "Confirm failed");
    return reply.code(500).send({ error: err.message });
  }
});

// Reset conversation — clears messages history (UI log + draft preserved unless
// the client also undoes staging). Used to recover from a corrupted state.
fastify.post("/admin/api/reset-conversation", async () => {
  const session = await getSession();
  await resetMessages(session.sessionId);
  await clearDraft(session.sessionId);
  return { ok: true };
});

// Cancel — client clicked "No, cancel". Discards the draft.
fastify.post("/admin/api/cancel", async (req, reply) => {
  const session = await getSession();
  await clearDraft(session.sessionId);
  await appendUiEntry(session.sessionId, { kind: "cancelled" });
  return reply.send({ ok: true });
});

// Publish — shadow-deploy + smoke + atomic swap.
fastify.post("/admin/api/publish", async (req, reply) => {
  const session = await getSession();
  if (!(await checkRateLimit(session.sessionId, "publishes_today", 10))) {
    return reply.code(429).send({ error: "Denní limit publikací vyčerpán (10/den)." });
  }
  try {
    const { commit } = await gitOps.publishWithSmoke(smokeCheck);
    await bumpCounter(session.sessionId, "publishes_today");
    await appendUiEntry(session.sessionId, {
      kind: "published",
      commit,
      liveUrl: LIVE_URL,
    });
    await notifyPublish({
      clientPrompt: session.uiLog.slice(-10).filter(e => e.kind === "user").pop()?.text || "(?)",
      summary: session.uiLog.slice(-10).filter(e => e.kind === "staged").pop()?.summary || "(?)",
      commitHash: commit,
      commitLink: `https://github.com/martinbergercz-diginew/prototypes/commit/${commit}`,
      diff: "",   // TODO: include short diff
    }).catch(err => fastify.log.warn({ err }, "Email notify failed (non-fatal)"));
    return reply.send({ kind: "published", commit, liveUrl: LIVE_URL });
  } catch (err) {
    if (err.code === "SMOKE_FAILED") {
      await appendUiEntry(session.sessionId, { kind: "smoke_failed", reason: err.message });
      return reply.code(400).send({ error: err.message, smoke: true });
    }
    fastify.log.error({ err }, "Publish failed");
    return reply.code(500).send({ error: err.message });
  }
});

// Undo — discard the unpublished staging commit.
fastify.post("/admin/api/undo", async () => {
  const session = await getSession();
  await gitOps.undoStaging();
  await clearDraft(session.sessionId);
  await appendUiEntry(session.sessionId, { kind: "undone" });
  return { ok: true };
});

// Redeploy main — used by Martin after pushing edits from claude.ai.
// Pulls latest main, smoke-tests, atomic-swaps live. No merge, no push.
// Protected by a shared secret in the X-Admin-Token header so it can't be
// hit anonymously through Caddy's basic-auth.
fastify.post("/admin/api/redeploy-main", async (req, reply) => {
  const expected = process.env.REDEPLOY_TOKEN;
  if (!expected) return reply.code(503).send({ error: "REDEPLOY_TOKEN not configured" });
  if (req.headers["x-admin-token"] !== expected) {
    return reply.code(401).send({ error: "Invalid token" });
  }
  try {
    const { commit } = await gitOps.redeployMain(smokeCheck);
    return { ok: true, commit, liveUrl: LIVE_URL };
  } catch (err) {
    if (err.code === "SMOKE_FAILED") {
      return reply.code(400).send({ error: err.message, smoke: true });
    }
    fastify.log.error({ err }, "Redeploy failed");
    return reply.code(500).send({ error: err.message });
  }
});

// Revert — inverse-commit a past commit.
fastify.post("/admin/api/revert", async (req, reply) => {
  const { commit } = req.body ?? {};
  if (!commit) return reply.code(400).send({ error: "commit required" });
  try {
    await gitOps.revertCommit(commit);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

// History.
fastify.get("/admin/api/history", async () => {
  const commits = await gitOps.historySince(50);
  return { commits };
});

// Uploads.
fastify.post("/admin/api/upload", async (req, reply) => {
  const parts = req.parts ? req.parts() : null;
  if (!parts) {
    return reply.code(400).send({ error: "multipart/form-data required" });
  }
  let result = null;
  for await (const part of parts) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      result = await handleUpload({
        buffer,
        mimeType: part.mimetype,
        originalName: part.filename,
        repoRoot: REPO_PATH,
      });
      await uploadsStore.add(result);
    }
  }
  if (!result) return reply.code(400).send({ error: "No file uploaded." });
  return result;
});

// Enable multipart parsing for /upload.
const multipart = await import("@fastify/multipart").catch(() => null);
if (multipart?.default) {
  await fastify.register(multipart.default, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });
}

// Root → /admin/.
fastify.get("/", async (_req, reply) => reply.redirect("/admin/"));

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`admin-service listening on http://${HOST}:${PORT} (dryRun=${DRY_RUN})`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
