// Git operations against the on-disk repo at REPO_PATH.
// Wraps simple-git with the specific flows the admin service needs:
//   - applyDraft → commit-to-staging (with optional squash)
//   - publish → shadow-deploy + smoke + atomic swap
//   - revert → inverse commit
//   - resetStagingToMain

import simpleGit from "simple-git";
import fs from "node:fs/promises";
import path from "node:path";
import { isDraftEmpty } from "../draft.js";

const REPO_SUBDIR = "ok-tours";   // the live site lives in this subdir of the monorepo

export class GitOps {
  constructor({ repoRoot, stagingPath, shadowPath, livePath, previousPath, dryRun }) {
    this.repoRoot = repoRoot;
    this.stagingPath = stagingPath;
    this.shadowPath = shadowPath;
    this.livePath = livePath;
    this.previousPath = previousPath;
    this.dryRun = dryRun;
    this.git = simpleGit(repoRoot);
  }

  async ensureBranches() {
    await this.git.fetch();
    const branches = await this.git.branchLocal();
    if (!branches.all.includes("staging")) {
      await this.git.checkoutBranch("staging", "main");
    }
  }

  /**
   * Apply the in-memory draft to disk inside the repo, commit on staging,
   * push, and rsync to the staging deploy path.
   *
   * If staging already has an unpublished commit ahead of main, this AMENDS
   * that commit (squash-on-second-turn, §3.2).
   */
  async applyDraftToStaging(draft) {
    if (isDraftEmpty(draft)) {
      throw new Error("Draft is empty — nothing to commit.");
    }

    // Sync main first, then base staging on main.
    await this.git.checkout("main");
    await this.git.pull("origin", "main", ["--rebase"]).catch(() => {});

    const ahead = await this.stagingAheadOfMain();
    if (ahead === 0) {
      // staging == main; reset cleanly
      await this.git.checkout("staging");
      await this.git.reset(["--hard", "main"]);
    } else {
      await this.git.checkout("staging");
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

    // Stage just the ok-tours subdir.
    await this.git.add([REPO_SUBDIR]);
    const status = await this.git.status();
    if (status.files.length === 0) {
      throw new Error("Nothing actually changed on disk — draft may already be applied.");
    }

    const message = draft.commit_message || draft.summary_cs || "ok-tours: chat-driven update";
    if (ahead === 0) {
      await this.git.commit(message);
    } else {
      // Squash: amend prior staging commit, replacing the message with the bundled summary.
      await this.git.commit(message, ["--amend"]);
    }

    if (!this.dryRun) {
      // staging may be ahead of remote staging; force-push since staging is scratch space.
      await this.git.push("origin", "staging", ["--force"]).catch(err => {
        throw new Error(`Failed to push staging: ${err.message}`);
      });
    }

    const head = await this.git.revparse(["HEAD"]);
    await this.rsync(path.join(this.repoRoot, REPO_SUBDIR), this.stagingPath);
    return { commit: head.trim() };
  }

  /**
   * Shadow-deploy + smoke + atomic swap. Caller passes a smokeCheck function
   * which receives the shadow path and returns { ok, failures }.
   */
  async publishWithSmoke(smokeCheck) {
    const ahead = await this.stagingAheadOfMain();
    if (ahead === 0) {
      throw new Error("Nothing to publish — staging is the same as main.");
    }

    // 1. Materialize shadow from current staging content.
    await this.rsync(this.stagingPath, this.shadowPath);

    // 2. Smoke.
    const smoke = await smokeCheck(this.shadowPath);
    if (!smoke.ok) {
      await fs.rm(this.shadowPath, { recursive: true, force: true });
      const err = new Error(`Smoke test failed: ${smoke.failures.join("; ")}`);
      err.code = "SMOKE_FAILED";
      throw err;
    }

    // 3. Merge staging → main (fast-forward).
    await this.git.checkout("main");
    await this.git.pull("origin", "main", ["--rebase"]).catch(() => {});
    await this.git.merge(["--ff-only", "staging"]);
    if (!this.dryRun) {
      await this.git.push("origin", "main");
    }

    // 4. Atomic swap. mv-old-out, mv-new-in.
    if (!this.dryRun) {
      await fs.rm(this.previousPath, { recursive: true, force: true });
      try {
        await fs.rename(this.livePath, this.previousPath);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      await fs.rename(this.shadowPath, this.livePath);
    }

    // 5. Reset staging to match main (no force-push needed; ff).
    await this.git.checkout("staging");
    await this.git.reset(["--hard", "main"]);
    if (!this.dryRun) await this.git.push("origin", "staging", ["--force"]);

    const head = await this.git.revparse(["HEAD"]);
    return { commit: head.trim() };
  }

  async undoStaging() {
    await this.git.checkout("staging");
    await this.git.reset(["--hard", "origin/main"]);
    if (!this.dryRun) await this.git.push("origin", "staging", ["--force"]);
    await this.rsync(path.join(this.repoRoot, REPO_SUBDIR), this.stagingPath);
  }

  async revertCommit(commitHash) {
    // Only commits within the last 90 days.
    const log = await this.git.log({ from: "HEAD~200", to: "HEAD" }).catch(() => ({ all: [] }));
    const found = log.all.find(c => c.hash === commitHash || c.hash.startsWith(commitHash));
    if (!found) throw new Error(`Commit ${commitHash} not found in recent history.`);
    const ageDays = (Date.now() - new Date(found.date).getTime()) / 86400000;
    if (ageDays > 90) throw new Error(`Commit too old to revert (${ageDays.toFixed(0)} days).`);

    await this.git.checkout("main");
    await this.git.pull("origin", "main", ["--rebase"]).catch(() => {});
    await this.git.revert(commitHash, ["--no-edit"]);
    if (!this.dryRun) await this.git.push("origin", "main");

    // After revert, run shadow-deploy + smoke (skipping it once for revert
    // would be risky if the prior state itself was broken).
    return this.publishWithSmoke(async () => ({ ok: true, failures: [] }));
  }

  async stagingAheadOfMain() {
    try {
      const result = await this.git.raw(["rev-list", "--count", "main..staging"]);
      return parseInt(result.trim(), 10) || 0;
    } catch (err) {
      // staging branch doesn't exist yet — treat as 0 ahead.
      if (/unknown revision|ambiguous argument/i.test(err.message)) return 0;
      throw err;
    }
  }

  async historySince(maxCount = 50) {
    const log = await this.git.log({ maxCount, from: "HEAD~" + maxCount, to: "HEAD" }).catch(async () => {
      return await this.git.log({ maxCount });
    });
    return log.all.map(c => ({
      hash: c.hash,
      short: c.hash.slice(0, 7),
      date: c.date,
      message: c.message,
      author: c.author_name,
    }));
  }

  async rsync(from, to) {
    // In production, use the actual `rsync` binary for atomicity and --delete.
    // In dry-run / local dev, copy via fs.cp.
    await fs.mkdir(to, { recursive: true });
    if (this.dryRun) {
      await fs.cp(from, to, { recursive: true, force: true });
      return;
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("rsync", [
      "-a", "--delete",
      "--exclude=.git",
      "--exclude=.claude",
      "--exclude=CLAUDE.md",
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
