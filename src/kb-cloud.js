import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const PRODUCT_VERSION_PLACEHOLDER = "{{VXULTRA_VERSION}}";
const PRODUCT_VERSION_FALLBACK = "暂未取得，以官网为准";
const PRODUCT_METADATA_TIMEOUT_MS = 5000;

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
  const metadata = {};
  let listKey = "";
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2];
      listKey = ["triggers", "aliases", "tags"].includes(key) ? key : "";
      if (listKey && value.startsWith("[")) {
        try {
          const parsed = JSON.parse(value);
          metadata[key] = Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
        } catch {
          metadata[key] = [];
        }
      } else {
        metadata[key] = value.replace(/^['"]|['"]$/g, "");
      }
      continue;
    }
    const item = listKey && line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      if (!Array.isArray(metadata[listKey])) metadata[listKey] = [];
      metadata[listKey].push(item[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return metadata;
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
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[\p{Script=Han}]{2,}|[a-z0-9_.-]{2,}/gu) || [];
  const output = new Set();
  for (const token of tokens) {
    if (!/[\p{L}]/u.test(token)) continue;
    output.add(token);
    if (/^\p{Script=Han}+$/u.test(token)) {
      const characters = [...token];
      for (let index = 0; index < characters.length - 1; index += 1) {
        output.add(characters.slice(index, index + 2).join(""));
      }
    }
  }
  return [...output];
}

function compact(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function metadataScore(metadata, query) {
  let score = 0;
  for (const [field, weight] of [["triggers", 80], ["aliases", 40], ["tags", 15]]) {
    const values = Array.isArray(metadata[field]) ? metadata[field] : [metadata[field]];
    for (const value of new Set(values.map(compact))) {
      if (value.length >= 2 && /\p{L}/u.test(value) && query.includes(value)) score += weight;
    }
  }
  return score;
}

function textScore(text, queryTerms) {
  const haystack = text.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function relevantExcerpt(content, queryTerms, queryKey, maxChars) {
  if (content.length <= maxChars) return content;
  // Keep the introduction, then spend the remaining budget near matching text.
  const sections = content.split(/(?=^##\s+)/m);
  const introduction = sections[0].slice(0, Math.min(600, Math.floor(maxChars / 4)));
  const candidates = sections.slice(1).map((section, index) => {
    const heading = section.split("\n", 1)[0];
    return {
      section,
      index,
      score: textScore(section, queryTerms) +
        2 * textScore(heading, queryTerms) +
        (compact(heading).includes(queryKey) ? 4 : 0),
    };
  });
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const best = candidates[0]?.score ? candidates[0].section : content;
  const separator = "\n\n[...]\n\n";
  const budget = Math.max(0, maxChars - introduction.length - separator.length);
  let start = 0;
  if (best.length > budget) {
    const haystack = best.toLowerCase();
    let bestScore = -1;
    for (const term of queryTerms) {
      const position = haystack.indexOf(term);
      if (position < 0) continue;
      const offset = Math.max(0, position - Math.floor(budget / 4));
      const score = textScore(best.slice(offset, offset + budget), queryTerms);
      if (score > bestScore) {
        start = offset;
        bestScore = score;
      }
    }
  }
  return `${introduction}${separator}${best.slice(start, start + budget)}`.slice(0, maxChars);
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
  constructor(config, logger = console, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.timer = null;
    this.state = {
      enabled: Boolean(config.enabled),
      ready: false,
      syncing: false,
      noteCount: 0,
      lastSyncAt: "",
      lastError: "",
      localDir: config.localDir,
      productVersion: "",
      productVersionFetchedAt: "",
      productVersionError: "",
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

  renderKnowledge(content) {
    return String(content || "").replaceAll(
      PRODUCT_VERSION_PLACEHOLDER,
      this.state.productVersion || PRODUCT_VERSION_FALLBACK,
    );
  }

  async refreshProductVersion() {
    const url = String(this.config.productMetadataUrl || "").trim();
    if (!url || typeof this.fetch !== "function") return;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PRODUCT_METADATA_TIMEOUT_MS,
    );
    try {
      const response = await this.fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`official product metadata returned HTTP ${response.status}`);
      }
      const body = await response.json();
      const version = String(body?.version || "").trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error("official product metadata has no valid version");
      }
      this.state.productVersion = version;
      this.state.productVersionFetchedAt = new Date().toISOString();
      this.state.productVersionError = "";
    } catch (error) {
      this.state.productVersionError = String(error.message || error).slice(0, 500);
      this.logger.warn?.("official product metadata refresh failed", {
        error: this.state.productVersionError,
      });
    } finally {
      clearTimeout(timeout);
    }
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
      await this.refreshProductVersion();
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

  async reconfigure(config, { started = false } = {}) {
    const previous = this.config;
    const directoryChanged =
      path.resolve(previous.localDir) !== path.resolve(config.localDir);
    this.stop();
    this.config = config;
    this.state.enabled = Boolean(config.enabled);
    this.state.localDir = config.localDir;
    if (directoryChanged || !this.state.enabled) {
      this.state.ready = false;
      this.state.noteCount = 0;
    }
    if (started && this.state.enabled) this.start();
    return this.status();
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
    const queryKey = compact(query);
    const files = await markdownFiles(this.config.localDir);
    const matches = [];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      const metadata = frontmatter(source);
      if (this.config.requireApproved && !approved(metadata)) continue;
      const documentAudience = audience(metadata);
      if (access !== "owner" && documentAudience !== "public") continue;
      const content = this.renderKnowledge(source);
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
      const score = metadataScore(metadata, queryKey) +
        Math.min(24, textScore(body, queryTerms)) +
        4 * textScore(title(body, file), queryTerms) +
        textScore(path.basename(file), queryTerms);
      if (!score) continue;
      matches.push({
        title: path.basename(file, path.extname(file)),
        path: path.relative(this.config.localDir, file),
        content: relevantExcerpt(body, queryTerms, queryKey, this.config.maxCharsPerNote),
        audience: documentAudience,
        score,
      });
    }
    return matches
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, this.config.maxNotes);
  }
}
