// Git operations against the on-disk repo at REPO_PATH.
//
// Design: the admin service operates on `workingBranch` and NEVER does
// `git checkout main`. Main is treated as a ref to compare against and to
// fast-forward when publishing, but the checkout/working-tree always stays
// on `workingBranch`. This matters in local dev where the admin-service
// runs inside an isolated `git worktree` — main is checked out in the
// developer's main worktree, and git refuses to check out the same branch
// in two worktrees at once.
//
// Conventions:
//   - workingBranch: where commits accumulate while waiting for "publish"
//       — "admin-service-local" in dev, "staging" in prod.
//   - "ahead of main": there are workingBranch commits not yet in main
//       — those are the unpublished staging changes.

import simpleGit from "simple-git";
import fs from "node:fs/promises";
import path from "node:path";
import { isDraftEmpty } from "../draft.js";

// The site content lives at the repo root in the standalone `oktours`
// repo (it used to be under `ok-tours/` in the old prototypes monorepo).
// Empty string = repo root; path.join collapses it away.
const REPO_SUBDIR = "";

// The admin-service's own directory inside the repo. Never deployed,
// never committed as part of a content change.
const ADMIN_DIR = "admin-service";

export class GitOps {
  constructor({
    repoRoot, stagingPath, shadowPath, livePath, previousPath, dryRun,
    workingBranch = "staging",
    publishedBranch = "main",
  }) {
    this.repoRoot = repoRoot;
    this.stagingPath = stagingPath;
    this.shadowPath = shadowPath;
    this.livePath = livePath;
    this.previousPath = previousPath;
    this.dryRun = dryRun;
    this.workingBranch = workingBranch;
    // publishedBranch = the ref the admin service treats as "currently live".
    // In prod = "main". In dev = "admin-service-published" (a private ref
    // the admin service controls — we never touch the developer's "main").
    this.publishedBranch = publishedBranch;
    this.git = simpleGit(repoRoot);
  }

  async ensureBranches() {
    await this.git.fetch().catch(() => {});
    const branches = await this.git.branchLocal();
    // publishedBranch needs to exist for aheadOf to work. Seed from main.
    if (!branches.all.includes(this.publishedBranch) && this.publishedBranch !== "main") {
      await this.git.raw(["branch", this.publishedBranch, "main"]);
    }
    if (!branches.all.includes(this.workingBranch)) {
      await this.git.raw(["branch", this.workingBranch, this.publishedBranch]);
    }
    // Make sure we're ON the working branch.
    const status = await this.git.status();
    if (status.current !== this.workingBranch) {
      await this.git.checkout(this.workingBranch);
    }
  }

  /**
   * Update publishedBranch from origin without checking out anything.
   * In prod: pulls origin/main into local main.
   * In dev: no-op (the admin-service-published ref is local-only and
   * advanced via publishWithSmoke; we don't sync it from anywhere).
   */
  async syncPublishedRef() {
    if (this.publishedBranch !== "main") return;
    try {
      await this.git.raw(["fetch", "origin", `${this.publishedBranch}:${this.publishedBranch}`]);
    } catch (err) {
      if (!/no upstream|Couldn't find remote|not a fast-forward|refusing to fetch/i.test(err.message)) {
        console.warn(`[git] syncPublishedRef warning: ${err.message}`);
      }
    }
  }

  async applyDraftToStaging(draft) {
    if (isDraftEmpty(draft)) {
      throw new Error("Draft is empty — nothing to commit.");
    }
    return this._withStash(() => this._applyDraftInner(draft));
  }

  async _applyDraftInner(draft) {
    await this.ensureBranches();
    await this.syncPublishedRef();

    const aheadBefore = await this.aheadOfMain();
    // If working branch is at publishedBranch, reset clean to it.
    if (aheadBefore === 0) {
      await this.git.reset(["--hard", this.publishedBranch]);
    }

    // Safety net: reject if any write_file shrinks an existing file by
    // more than 50%. Almost always a truncation bug (model summarized
    // instead of preserving full content). The smoke test would catch
    // this later but we'd rather refuse at commit time so the bad commit
    // never lands on the staging branch.
    for (const [relPath, newContent] of Object.entries(draft.writes)) {
      const abs = path.join(this.repoRoot, REPO_SUBDIR, relPath);
      let oldSize = 0;
      try { oldSize = (await fs.stat(abs)).size; } catch { oldSize = 0; }
      const newSize = Buffer.byteLength(newContent, "utf8");
      if (oldSize > 0 && newSize < oldSize * 0.5) {
        throw new Error(
          `Refusing to commit: ${relPath} would shrink from ${oldSize} to ${newSize} bytes ` +
          `(${Math.round((1 - newSize / oldSize) * 100)}% reduction). This is almost ` +
          `always a truncation bug. If you really want to replace this file with much ` +
          `smaller content, use edit_text_in_file to remove the unwanted sections instead.`
        );
      }
    }

    // Apply writes.
    for (const [relPath, content] of Object.entries(draft.writes)) {
      const abs = path.join(this.repoRoot, REPO_SUBDIR, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }

    // Apply deletes.
    for (const relPath of draft.deletes) {
      const abs = path.join(this.repoRoot, REPO_SUBDIR, relPath);
      await fs.rm(abs, { force: true });
    }

    // Stage every content change in the repo: the draft's writes and
    // deletes, plus any uploaded images/PDFs the client dropped into
    // uploads/ (those live on disk untracked until a commit picks them
    // up). admin-service/ is excluded so the service never commits its
    // own code as part of a content edit. Staging by directory scope —
    // rather than explicit per-file pathspecs — also means a draft that
    // references a not-yet-existing path can't crash `git add` with
    // "pathspec did not match any files".
    await this.git.add(["-A", "--", ".", ":(exclude)admin-service"]);
    const status = await this.git.status();
    if (status.files.length === 0) {
      throw new Error("Nothing actually changed on disk — draft may already be applied.");
    }

    const message = draft.commit_message || draft.summary_cs || "ok-tours: chat-driven update";
    if (aheadBefore === 0) {
      await this.git.commit(message);
    } else {
      // Squash: amend the pending staging commit.
      await this.git.commit(message, ["--amend"]);
    }

    if (!this.dryRun) {
      await this.git.push("origin", `${this.workingBranch}:staging`, ["--force"]).catch(err => {
        throw new Error(`Failed to push staging: ${err.message}`);
      });
    }

    const head = (await this.git.revparse(["HEAD"])).trim();
    await this.rsync(path.join(this.repoRoot, REPO_SUBDIR), this.stagingPath);
    return { commit: head };
  }

  async publishWithSmoke(smokeCheck) {
    return this._withStash(() => this._publishWithSmokeInner(smokeCheck));
  }

  async _publishWithSmokeInner(smokeCheck) {
    await this.ensureBranches();
    const ahead = await this.aheadOfMain();
    if (ahead === 0) {
      throw new Error("Nothing to publish — staging is the same as main.");
    }

    // Materialize shadow.
    await this.rsync(this.stagingPath, this.shadowPath);

    // Smoke.
    const smoke = await smokeCheck(this.shadowPath);
    if (!smoke.ok) {
      await fs.rm(this.shadowPath, { recursive: true, force: true });
      const err = new Error(`Smoke test failed: ${smoke.failures.join("; ")}`);
      err.code = "SMOKE_FAILED";
      throw err;
    }

    const newHead = (await this.git.revparse(["HEAD"])).trim();

    // Advance the publishedBranch ref to point at workingBranch HEAD.
    // In prod, publishedBranch=main, so this is the merge-into-main step
    // and we follow with a push to origin. In dev, publishedBranch is a
    // private ref (admin-service-published) that the developer never sees,
    // and there's no remote to push to.
    await this.git.raw(["update-ref", `refs/heads/${this.publishedBranch}`, newHead]);

    if (!this.dryRun && this.publishedBranch === "main") {
      await this.git.push("origin", this.publishedBranch).catch(err => {
        throw new Error(`Failed to push ${this.publishedBranch}: ${err.message}`);
      });
    }

    // Atomic swap of live content.
    if (!this.dryRun) {
      await fs.rm(this.previousPath, { recursive: true, force: true });
      try { await fs.rename(this.livePath, this.previousPath); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
      await fs.rename(this.shadowPath, this.livePath);
    } else {
      // Dev: just copy shadow over live.
      await fs.rm(this.livePath, { recursive: true, force: true });
      await fs.rename(this.shadowPath, this.livePath);
    }

    // After publish, workingBranch == main. Stay on workingBranch (no
    // checkout needed). On next edit, ensureBranches will detect ahead==0
    // and reset cleanly.

    if (!this.dryRun) {
      // Keep remote staging in sync with main.
      await this.git.push("origin", `${this.workingBranch}:staging`, ["--force"]).catch(() => {});
    }

    return { commit: newHead };
  }

  /**
   * Used when Martin pushes to main from claude.ai and wants to deploy
   * those changes without going through the chat flow.
   * Pulls latest main into the local ref, smokes shadow, swaps live.
   */
  async redeployMain(smokeCheck) {
    return this._withStash(() => this._redeployMainInner(smokeCheck));
  }

  async _redeployMainInner(smokeCheck) {
    await this.ensureBranches();
    await this.syncPublishedRef();

    // Reset workingBranch to match main so we deploy from a clean state.
    await this.git.reset(["--hard", this.publishedBranch]);
    if (!this.dryRun) {
      await this.git.push("origin", `${this.workingBranch}:staging`, ["--force"]).catch(() => {});
    }

    await this.rsync(path.join(this.repoRoot, REPO_SUBDIR), this.stagingPath);
    await this.rsync(this.stagingPath, this.shadowPath);

    const smoke = await smokeCheck(this.shadowPath);
    if (!smoke.ok) {
      await fs.rm(this.shadowPath, { recursive: true, force: true });
      const err = new Error(`Smoke test failed: ${smoke.failures.join("; ")}`);
      err.code = "SMOKE_FAILED";
      throw err;
    }

    if (!this.dryRun) {
      await fs.rm(this.previousPath, { recursive: true, force: true });
      try { await fs.rename(this.livePath, this.previousPath); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
      await fs.rename(this.shadowPath, this.livePath);
    } else {
      await fs.rm(this.livePath, { recursive: true, force: true });
      await fs.rename(this.shadowPath, this.livePath);
    }

    const head = (await this.git.revparse(["HEAD"])).trim();
    return { commit: head };
  }

  async undoStaging() {
    return this._withStash(async () => {
      await this.ensureBranches();
      await this.git.reset(["--hard", this.publishedBranch]);
      if (!this.dryRun) await this.git.push("origin", `${this.workingBranch}:staging`, ["--force"]).catch(() => {});
      await this.rsync(path.join(this.repoRoot, REPO_SUBDIR), this.stagingPath);
    });
  }

  async revertCommit(commitHash) {
    return this._withStash(async () => {
      await this.ensureBranches();
      const log = await this.git.log({ maxCount: 200 }).catch(() => ({ all: [] }));
      const found = log.all.find(c => c.hash === commitHash || c.hash.startsWith(commitHash));
      if (!found) throw new Error(`Commit ${commitHash} not found in recent history.`);
      const ageDays = (Date.now() - new Date(found.date).getTime()) / 86400000;
      if (ageDays > 90) throw new Error(`Commit too old to revert (${ageDays.toFixed(0)} days).`);

      // Make sure workingBranch is at main (or ahead — we revert from there).
      await this.syncPublishedRef();
      await this.git.reset(["--hard", this.publishedBranch]);

      await this.git.revert(commitHash, ["--no-edit"]);

      // Advance publishedBranch to include the revert.
      const newHead = (await this.git.revparse(["HEAD"])).trim();
      await this.git.raw(["update-ref", `refs/heads/${this.publishedBranch}`, newHead]);
      if (!this.dryRun && this.publishedBranch === "main") {
        await this.git.push("origin", this.publishedBranch).catch(() => {});
      }

      // Run shadow+smoke+swap.
      return this._publishLikeWithoutMerge();
    });
  }

  async _publishLikeWithoutMerge() {
    await this.rsync(path.join(this.repoRoot, REPO_SUBDIR), this.stagingPath);
    await this.rsync(this.stagingPath, this.shadowPath);
    if (!this.dryRun) {
      await fs.rm(this.previousPath, { recursive: true, force: true });
      try { await fs.rename(this.livePath, this.previousPath); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
      await fs.rename(this.shadowPath, this.livePath);
    } else {
      await fs.rm(this.livePath, { recursive: true, force: true });
      await fs.rename(this.shadowPath, this.livePath);
    }
    const head = (await this.git.revparse(["HEAD"])).trim();
    return { commit: head };
  }

  /**
   * Count commits on workingBranch that aren't in main. >0 = unpublished
   * staging changes.
   */
  /**
   * How many commits workingBranch is ahead of publishedBranch.
   * >0 = unpublished staged changes.
   */
  async aheadOfMain() {
    try {
      const result = await this.git.raw([
        "rev-list", "--count", `${this.publishedBranch}..${this.workingBranch}`,
      ]);
      return parseInt(result.trim(), 10) || 0;
    } catch (err) {
      if (/unknown revision|ambiguous argument/i.test(err.message)) return 0;
      throw err;
    }
  }

  // Kept as an alias so existing server code calling this name still works.
  async stagingAheadOfMain() {
    return this.aheadOfMain();
  }

  async historySince(maxCount = 50) {
    const log = await this.git.log({ maxCount }).catch(() => ({ all: [] }));
    return log.all.map(c => ({
      hash: c.hash,
      short: c.hash.slice(0, 7),
      date: c.date,
      message: c.message,
      author: c.author_name,
    }));
  }

  // ---- stash helpers (only meaningful in dev where source files share a worktree) ----

  async _withStash(fn) {
    const label = await this._stashNonContentChanges();
    try { return await fn(); }
    finally { await this._restoreStash(label); }
  }

  async _stashNonContentChanges() {
    const status = await this.git.status();
    // Content = the whole repo except the admin-service's own directory.
    // Stash any dirt under admin-service/ so it never rides along with a
    // client content commit.
    const dirtyOutsideContent = status.files.some(f => f.path.startsWith(ADMIN_DIR + "/"));
    if (!dirtyOutsideContent) return null;
    const label = `oktours-admin-autostash-${Date.now()}`;
    // Scope the stash to admin-service/ only — never stash content dirt
    // or pending uploads/, or they'd vanish from the working tree right
    // when the commit needs them.
    await this.git.raw(["stash", "push", "--include-untracked", "-m", label, "--", ADMIN_DIR]);
    return label;
  }

  async _restoreStash(label) {
    if (!label) return;
    try {
      const list = await this.git.raw(["stash", "list"]);
      const line = list.split("\n").find(l => l.includes(label));
      if (!line) return;
      const idx = line.match(/^stash@\{(\d+)\}/)?.[1];
      if (idx === undefined) return;
      await this.git.raw(["stash", "pop", `stash@{${idx}}`]);
    } catch (err) {
      console.warn(`Could not auto-pop stash ${label}: ${err.message}`);
    }
  }

  async rsync(from, to) {
    await fs.mkdir(to, { recursive: true });
    if (this.dryRun) {
      // In dev, plain recursive copy. Make sure to clean target first so
      // deletes propagate.
      const entries = await fs.readdir(to).catch(() => []);
      for (const name of entries) {
        if (name === ".git" || name === "admin-service") continue;
        await fs.rm(path.join(to, name), { recursive: true, force: true });
      }
      await fs.cp(from, to, {
        recursive: true,
        force: true,
        filter: src => {
          const base = path.basename(src);
          if (base === ".git" || base === "admin-service" || base === "node_modules") return false;
          return true;
        },
      });
      return;
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("rsync", [
      "-a", "--delete",
      "--exclude=.git",
      "--exclude=.gitignore",
      "--exclude=.claude",
      "--exclude=CLAUDE.md",
      "--exclude=HANDOFF.md",
      "--exclude=ADMIN_CHAT_SPEC.md",
      "--exclude=SETUP_GA4.md",
      "--exclude=admin-service",
      "--exclude=offer.html",
      "--exclude=offer-api.php",
      "--exclude=offer-state.json",
      "--exclude=index-v1.html",
      `${from}/`, `${to}/`,
    ]);
  }
}
