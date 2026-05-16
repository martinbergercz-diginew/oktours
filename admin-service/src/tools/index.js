// Typed tools exposed to Claude. Each tool returns a JSON-serializable
// result or throws. Errors are returned to Claude as tool_result content
// so the model can recover.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoPath, assertWritable, assertDeletable, PathError } from "../paths.js";
import { translate } from "../ops/translate.js";
import { notifyDeveloper } from "../ops/mailer.js";

const MAX_READ_BYTES = 200 * 1024;

export const TOOL_DEFINITIONS = [
  {
    name: "list_files",
    description: "List files in a directory inside the site repo. Pass an empty string for the repo root.",
    input_schema: {
      type: "object",
      properties: { directory: { type: "string" } },
      required: ["directory"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file from the site repo. Max 200 KB.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Stage a full-file write into the in-memory draft. Use ONLY when you're creating a new file or replacing most of the content. For small edits (changing a word, a paragraph, a single tag), use edit_text_in_file instead — it's far more efficient. Does NOT touch disk until propose_change is confirmed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_text_in_file",
    description: "Replace one exact substring in a file with another. Preferred over write_file for small edits — you don't need to resend the whole file. The old_text must appear EXACTLY ONCE in the file (or fewer characters fail the call). The new_text replaces it. Stages into the in-memory draft like write_file. Use this for typos, single-word changes, removing or adding a tag, swapping a phone number, etc.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string", description: "The exact substring to find. Must match a single occurrence in the file." },
        new_text: { type: "string", description: "What to replace it with. May be empty to delete." },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "delete_file",
    description: "Stage a file delete into the in-memory draft. Protected files cannot be deleted.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_pages",
    description: "List every visible HTML page in the site with its language. Use this before editing to identify which language variants need to be updated together.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "translate",
    description: "Auto-translate text between Czech and English. Use when the client supplies only one language and you need to update the other language variant. The translation will be shown to the client for review in the confirmation step.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        from: { type: "string", enum: ["cs", "en"] },
        to: { type: "string", enum: ["cs", "en"] },
      },
      required: ["text", "from", "to"],
    },
  },
  {
    name: "list_uploads",
    description: "List recent images and PDFs the client uploaded but hasn't yet been referenced in a commit.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "notify_developer",
    description: "Send the developer (Martin) an email with a request the client cannot do via chat — structural or design changes: new section types, layout changes, colour/restyle, anything beyond editing text/images/PDFs in existing sections. Call this ONLY after the client has confirmed they want Martin notified. After it succeeds, tell the client the message really was sent. Never claim a message was sent without calling this tool.",
    input_schema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "Clear, self-contained Czech description of what the client wants. Include specifics — colours, sizes, which page/section — so Martin can act on it without further context.",
        },
      },
      required: ["request"],
    },
  },
  {
    name: "propose_change",
    description: "Surface the staged draft to the client in plain Czech and ask them to confirm. NO commit happens until the client clicks Yes. After calling this you should STOP the turn — wait for the next user message via the confirmation endpoint.",
    input_schema: {
      type: "object",
      properties: {
        summary_cs: {
          type: "string",
          description: "Plain-Czech, one-paragraph summary of what's about to change. Mention page(s), language(s), and new value(s).",
        },
        affected_pages: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths of pages that will be visibly affected.",
        },
        is_destructive: {
          type: "boolean",
          description: "True if anything visible is being removed (text block, image, PDF, team member, section).",
        },
        language_scope: {
          type: "string",
          enum: ["cs", "en", "both"],
          description: "Which languages the change touches.",
        },
        commit_message: {
          type: "string",
          description: "Short imperative commit message in Czech, e.g. 'Aktualizovat roli Silvie v sekci Náš tým'.",
        },
      },
      required: ["summary_cs", "affected_pages", "is_destructive", "language_scope", "commit_message"],
    },
  },
];

/**
 * Execute a single tool call against the current session context.
 * Returns { content, is_error } shaped for Anthropic SDK tool_result.
 */
export async function runTool(name, input, ctx) {
  try {
    const result = await dispatch(name, input, ctx);
    return { content: JSON.stringify(result), is_error: false };
  } catch (err) {
    const message = err instanceof PathError ? err.message : (err.message || String(err));
    return { content: JSON.stringify({ error: message }), is_error: true };
  }
}

async function dispatch(name, input, ctx) {
  switch (name) {
    case "list_files": return await toolListFiles(input, ctx);
    case "read_file":  return await toolReadFile(input, ctx);
    case "write_file": return toolWriteFile(input, ctx);
    case "edit_text_in_file": return await toolEditText(input, ctx);
    case "delete_file": return await toolDeleteFile(input, ctx);
    case "list_pages": return toolListPages(ctx);
    case "translate":  return await toolTranslate(input, ctx);
    case "list_uploads": return await toolListUploads(ctx);
    case "notify_developer": return await toolNotifyDeveloper(input, ctx);
    case "propose_change": return toolProposeChange(input, ctx);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function toolListFiles({ directory }, { repoRoot }) {
  const dir = resolveRepoPath(repoRoot, directory || ".");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
    .map(e => ({
      name: e.name,
      kind: e.isDirectory() ? "directory" : "file",
    }));
}

async function toolReadFile({ path: relPath }, { repoRoot }) {
  const abs = resolveRepoPath(repoRoot, relPath);
  const stat = await fs.stat(abs);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large to read (${stat.size} bytes, max ${MAX_READ_BYTES}).`);
  }
  const content = await fs.readFile(abs, "utf8");
  return { path: relPath, content };
}

function toolWriteFile({ path: relPath, content }, { repoRoot, draft }) {
  assertWritable(repoRoot, relPath);
  if (typeof content !== "string") {
    throw new Error("write_file: content must be a string.");
  }
  draft.writes[relPath] = content;
  return { staged: true, path: relPath, bytes: Buffer.byteLength(content, "utf8") };
}

async function toolEditText({ path: relPath, old_text, new_text }, { repoRoot, draft }) {
  assertWritable(repoRoot, relPath);
  if (typeof old_text !== "string" || typeof new_text !== "string") {
    throw new Error("edit_text_in_file: old_text and new_text must be strings.");
  }
  if (old_text === "") {
    throw new Error("edit_text_in_file: old_text cannot be empty (use write_file to create a new file).");
  }
  // Source of truth: if the draft already has a staged write for this path,
  // edit against that. Otherwise, read from disk.
  let current;
  if (Object.prototype.hasOwnProperty.call(draft.writes, relPath)) {
    current = draft.writes[relPath];
  } else {
    const abs = resolveRepoPath(repoRoot, relPath);
    current = await fs.readFile(abs, "utf8");
  }
  // Count occurrences — must be exactly one to avoid ambiguity.
  const parts = current.split(old_text);
  if (parts.length === 1) {
    throw new Error(`edit_text_in_file: old_text not found in ${relPath}. Re-read the file to see the exact current content.`);
  }
  if (parts.length > 2) {
    throw new Error(`edit_text_in_file: old_text appears ${parts.length - 1} times in ${relPath}. Make it more specific (include more surrounding context) so it matches exactly once.`);
  }
  const updated = parts[0] + new_text + parts[1];
  draft.writes[relPath] = updated;
  return {
    staged: true,
    path: relPath,
    bytes_before: Buffer.byteLength(current, "utf8"),
    bytes_after: Buffer.byteLength(updated, "utf8"),
  };
}

async function toolDeleteFile({ path: relPath }, { repoRoot, draft }) {
  const abs = assertDeletable(repoRoot, relPath);
  // Don't stage a delete for a file that isn't there. A no-op delete
  // can't remove anything and previously slipped through to the commit
  // step as a confusing failure.
  if (!Object.prototype.hasOwnProperty.call(draft.writes, relPath)) {
    try {
      await fs.access(abs);
    } catch {
      throw new Error(`delete_file: '${relPath}' doesn't exist — nothing to delete. Check the path with list_files.`);
    }
  }
  if (!draft.deletes.includes(relPath)) draft.deletes.push(relPath);
  draft.is_destructive = true;
  return { staged: true, path: relPath };
}

function toolListPages({ siteConfig }) {
  return siteConfig.pages;
}

async function toolTranslate({ text, from, to }, _ctx) {
  if (from === to) return { translated: text };
  const out = await translate(text, from, to);
  return { translated: out };
}

async function toolListUploads({ uploadsStore }) {
  return await uploadsStore.list();
}

async function toolNotifyDeveloper({ request }, ctx) {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("notify_developer: request must be a non-empty string.");
  }
  const result = await notifyDeveloper({
    request: request.trim(),
    clientPrompt: ctx.userMessage || "",
  });
  return { sent: true, dryRun: !!result.dryRun };
}

function toolProposeChange(input, { draft }) {
  const { summary_cs, affected_pages, is_destructive, language_scope, commit_message } = input;
  draft.summary_cs = summary_cs;
  draft.affected_pages = affected_pages;
  // Destructive if EITHER the model marks it, or any delete is staged.
  draft.is_destructive = !!is_destructive || draft.deletes.length > 0;
  draft.language_scope = language_scope;
  draft.commit_message = commit_message;
  draft.awaiting_confirmation = true;
  draft.created_at = new Date().toISOString();
  return {
    awaiting_confirmation: true,
    summary_cs,
    is_destructive: draft.is_destructive,
    affected_pages,
  };
}
