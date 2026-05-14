// Tracks recent uploads with a 24-hour TTL so Claude knows what the
// client just dropped in. Cleared automatically as entries expire.

import fs from "node:fs/promises";
import path from "node:path";

const UPLOADS_FILE = path.join(process.env.DATA_DIR || "./data", "uploads-pending.json");
const TTL_MS = 24 * 60 * 60 * 1000;

export class UploadsStore {
  constructor() { this.cache = null; }

  async _load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(UPLOADS_FILE, "utf8");
      this.cache = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.cache = [];
    }
    return this.cache;
  }

  async _persist() {
    await fs.mkdir(path.dirname(UPLOADS_FILE), { recursive: true });
    await fs.writeFile(UPLOADS_FILE, JSON.stringify(this.cache, null, 2));
  }

  async _purgeExpired() {
    const now = Date.now();
    const before = this.cache.length;
    this.cache = this.cache.filter(u => now - new Date(u.uploaded_at).getTime() < TTL_MS);
    if (this.cache.length !== before) await this._persist();
  }

  async add(entry) {
    await this._load();
    this.cache.push({
      path: entry.path,
      original_name: entry.original_name,
      uploaded_at: new Date().toISOString(),
      kind: entry.kind,
      size_kb: entry.size_kb,
    });
    await this._persist();
  }

  async list() {
    await this._load();
    await this._purgeExpired();
    return this.cache;
  }

  async clear() {
    this.cache = [];
    await this._persist();
  }
}
