import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const MAX_DOCUMENT_BYTES = 1024 * 1024;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `${command} failed`).trim()));
    });
  });
}

function frontmatter(content) {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return {};
  return Object.fromEntries(
    frontmatter[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1].toLowerCase(), match[2].replace(/^['"]|['"]$/g, "")]),
  );
}

function approved(metadata) {
  return /^true$/i.test(String(metadata.approved || ""));
}

function audience(metadata) {
  return String(metadata.audience || "").trim().toLowerCase() === "public"
    ? "public"
    : "owner";
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function title(content, file) {
  const heading = String(content || "")
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line));
  return heading
    ? heading.replace(/^#\s+/, "").trim()
    : path.basename(file, path.extname(file));
}

function terms(text) {
  return [
    ...new Set(
      String(text || "")
        .toLowerCase()
        .match(/[\p{Script=Han}]{2,}|[a-z0-9_.-]{2,}/gu) || [],
    ),
  ];
}

async function markdownFiles(root, limit = 2000) {
  const output = [];
  const pending = [root];
  while (pending.length && output.length < limit) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (entry.isFile() && /\.md$/i.test(entry.name)) output.push(target);
      if (output.length >= limit) break;
    }
  }
  return output;
}

export class KnowledgeBaseCloud {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.state = {
      enabled: Boolean(config.enabled),
      ready: false,
      syncing: false,
      noteCount: 0,
      lastSyncAt: "",
      lastError: "",
      localDir: config.localDir,
    };
  }

  status() {
    return { ...this.state };
  }

  resolveDocument(input) {
    const file = String(input || "").trim();
    if (
      !file ||
      file.includes("\\") ||
      path.posix.isAbsolute(file) ||
      !/\.md$/i.test(file)
    ) {
      throw new Error("invalid knowledge document path");
    }
    const normalized = path.posix.normalize(file);
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.split("/").some((part) => !part || part === "." || part.startsWith("."))
    ) {
      throw new Error("invalid knowledge document path");
    }
    const root = path.resolve(this.config.localDir);
    const target = path.resolve(root, ...normalized.split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error("invalid knowledge document path");
    }
    return { file: normalized, target };
  }

  async refreshLocalState() {
    await fs.mkdir(this.config.localDir, { recursive: true, mode: 0o700 });
    const files = await markdownFiles(this.config.localDir);
    this.state.ready = true;
    this.state.noteCount = files.length;
    return files;
  }

  async listDocuments() {
    const files = await this.refreshLocalState();
    const documents = await Promise.all(files.map(async (file) => {
      const [content, info] = await Promise.all([
        fs.readFile(file, "utf8"),
        fs.stat(file),
      ]);
      const metadata = frontmatter(content);
      return {
        file: path.relative(this.config.localDir, file).split(path.sep).join("/"),
        title: title(content, file),
        approved: approved(metadata),
        audience: audience(metadata),
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        hash: contentHash(content),
        excerpt: content.replace(/\s+/g, " ").trim().slice(0, 180),
      };
    }));
    return documents.sort((left, right) => left.file.localeCompare(right.file));
  }

  async readDocument(input) {
    const { file, target } = this.resolveDocument(input);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("knowledge document is not a regular file");
    }
    const content = await fs.readFile(target, "utf8");
    const metadata = frontmatter(content);
    return {
      file,
      title: title(content, file),
      content,
      approved: approved(metadata),
      audience: audience(metadata),
      bytes: Buffer.byteLength(content),
      updatedAt: info.mtime.toISOString(),
      hash: contentHash(content),
    };
  }

  async writeDocument(input, content, options = {}) {
    const { file, target } = this.resolveDocument(input);
    const value = String(content ?? "");
    if (!value.trim()) throw new Error("knowledge document cannot be empty");
    if (Buffer.byteLength(value) > MAX_DOCUMENT_BYTES) {
      throw new Error("knowledge document is too large");
    }
    const current = await this.readDocument(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      options.baseHash &&
      current?.hash &&
      String(options.baseHash) !== current.hash
    ) {
      const error = new Error("knowledge document changed on disk");
      error.code = "KB_CONFLICT";
      error.current = current;
      throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      value.endsWith("\n") ? value : `${value}\n`,
      { mode: 0o600 },
    );
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    await this.refreshLocalState();
    return this.readDocument(file);
  }

  async deleteDocument(input, options = {}) {
    const current = await this.readDocument(input);
    if (options.baseHash && String(options.baseHash) !== current.hash) {
      const error = new Error("knowledge document changed on disk");
      error.code = "KB_CONFLICT";
      error.current = current;
      throw error;
    }
    const { target } = this.resolveDocument(input);
    await fs.unlink(target);
    await this.refreshLocalState();
    return { file: current.file };
  }

  async sync() {
    if (!this.config.enabled) return this.status();
    if (this.state.syncing) return this.status();
    this.state.syncing = true;
    this.state.lastError = "";
    try {
      const gitDirectory = path.join(this.config.localDir, ".git");
      const hasCheckout = await fs.stat(gitDirectory).then(
        () => true,
        () => false,
      );
      if (!hasCheckout) {
        if (!this.config.remote) {
          await fs.mkdir(this.config.localDir, { recursive: true, mode: 0o700 });
        } else {
          await fs.mkdir(path.dirname(this.config.localDir), {
            recursive: true,
            mode: 0o700,
          });
          await run("git", [
            "clone",
            "--depth",
            "1",
            "--branch",
            this.config.branch,
            this.config.remote,
            this.config.localDir,
          ]);
        }
      } else if (this.config.remote) {
        await run("git", ["fetch", "--depth", "1", "origin", this.config.branch], {
          cwd: this.config.localDir,
        });
        await run("git", ["merge", "--ff-only", `origin/${this.config.branch}`], {
          cwd: this.config.localDir,
        });
      }
      await this.refreshLocalState();
      this.state.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.state.ready = false;
      this.state.lastError = String(error.message || error).slice(0, 500);
      this.logger.error("knowledge base sync failed", {
        error: this.state.lastError,
      });
    } finally {
      this.state.syncing = false;
    }
    return this.status();
  }

  start() {
    if (!this.config.enabled || this.timer) return;
    void this.sync();
    const interval = Math.max(
      60,
      Number(this.config.syncIntervalSeconds || 900),
    );
    this.timer = setInterval(() => void this.sync(), interval * 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async search(query, context = {}) {
    if (!this.config.enabled || !this.state.ready) return [];
    const access = context.access === "owner" ? "owner" : "public";
    const queryTerms = terms(query);
    if (!queryTerms.length) return [];
    const files = await markdownFiles(this.config.localDir);
    const matches = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      const metadata = frontmatter(content);
      if (this.config.requireApproved && !approved(metadata)) continue;
      const documentAudience = audience(metadata);
      if (access !== "owner" && documentAudience !== "public") continue;
      const haystack = `${path.basename(file)}\n${content}`.toLowerCase();
      const score = queryTerms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      if (!score) continue;
      matches.push({
        title: path.basename(file, path.extname(file)),
        path: path.relative(this.config.localDir, file),
        content: content.slice(0, this.config.maxCharsPerNote),
        audience: documentAudience,
        score,
      });
    }
    return matches
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.maxNotes);
  }
}
