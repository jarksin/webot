import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export class SessionStore {
  constructor(directory, historyTurns = 12) {
    this.directory = directory;
    this.maxEntries = Math.max(2, historyTurns * 2);
    this.cache = new Map();
  }

  fileFor(chatKey) {
    const digest = crypto.createHash("sha256").update(chatKey).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }

  async history(chatKey) {
    if (this.cache.has(chatKey)) return [...this.cache.get(chatKey)];
    try {
      const data = JSON.parse(await fs.readFile(this.fileFor(chatKey), "utf8"));
      const history = Array.isArray(data.history) ? data.history : [];
      this.cache.set(chatKey, history.slice(-this.maxEntries));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.cache.set(chatKey, []);
    }
    return [...this.cache.get(chatKey)];
  }

  async append(chatKey, role, content, messageRowId) {
    const history = await this.history(chatKey);
    history.push({ role, content: String(content), at: Date.now(),
      ...(messageRowId ? { messageRowId } : {}),
    });
    const bounded = history.slice(-this.maxEntries);
    this.cache.set(chatKey, bounded);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      this.fileFor(chatKey),
      `${JSON.stringify({ version: 1, history: bounded }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async clear(chatKey) {
    this.cache.delete(chatKey);
    await fs.rm(this.fileFor(chatKey), { force: true });
  }
}
