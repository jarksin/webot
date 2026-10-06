import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const hydratedFiles = new WeakMap();
const fileReferences = new WeakMap();
export const MAX_MODEL_FILES = 6;
const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_FILE_CONTEXT_CHARACTERS = 128 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".tsv",
  ".yaml", ".yml", ".xml", ".log", ".ini", ".toml", ".rst",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go",
  ".sh", ".sql", ".html", ".css",
]);

function decodeText(data, truncated) {
  let encoding = "utf-8";
  if (data[0] === 0xff && data[1] === 0xfe) encoding = "utf-16le";
  if (data[0] === 0xfe && data[1] === 0xff) encoding = "utf-16be";
  const decoder = new TextDecoder(encoding, { fatal: true });
  const text = decoder.decode(data, { stream: truncated });
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new Error("attachment contains binary data");
  }
  return { text, encoding };
}

export async function markHydratedFile(attachment, cached) {
  const result = { ...attachment, ...cached };
  if (!["file", "video"].includes(attachment?.kind) || !cached?.localPath) return result;
  const info = await fs.lstat(cached.localPath);
  if (!info.isFile() || info.size !== cached.size) {
    throw new Error("cached attachment is not a matching regular file");
  }
  delete result.error;
  const filename = path.win32.basename(path.basename(String(
    attachment.filename || cached.filename || "file",
  )));
  hydratedFiles.set(result, {
    path: cached.localPath,
    filename,
    size: info.size,
    mime: String(attachment.mime || cached.mime || ""),
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    readableAsText:
      TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()) ||
      String(attachment.mime || cached.mime || "").toLowerCase().startsWith("text/"),
  });
  return result;
}

export function cachedFilePath(attachment) {
  return hydratedFiles.get(attachment)?.path || "";
}

export function redactFilePaths(text, files) {
  let result = String(text || "");
  for (const file of files) {
    const verified = fileReferences.get(file);
    if (!verified) continue;
    for (const [cachePath, replacement] of [
      [verified.path, verified.filename],
      [path.dirname(verified.path), "[attachment cache]"],
    ]) {
      for (const value of [
        pathToFileURL(cachePath).href,
        cachePath,
        JSON.stringify(cachePath).slice(1, -1),
        encodeURI(cachePath),
        encodeURIComponent(cachePath),
      ]) {
        result = result.replaceAll(value, replacement);
      }
    }
  }
  return result;
}

export function modelFiles(message, mediaContext = []) {
  const files = [];
  const seen = new Set();
  function add(current) {
    for (const attachment of current?.attachments || []) {
      const verified = hydratedFiles.get(attachment);
      if (!verified || seen.has(verified.path) || files.length >= MAX_MODEL_FILES) continue;
      seen.add(verified.path);
      const file = {
        id: `file-${files.length + 1}`,
        filename: verified.filename,
        size: verified.size,
        mime: verified.mime,
        status: "available",
        readableAsText: verified.readableAsText,
        messageId: String(current.messageId || ""),
        localPath: verified.path,
      };
      fileReferences.set(file, verified);
      files.push(file);
    }
    if (current?.reference) add({ ...current.reference, reference: null });
  }
  add(message);
  for (const entry of [...mediaContext].reverse()) {
    const prior = entry.message;
    if (
      prior?.sourceId === message?.sourceId &&
      prior?.chatId === message?.chatId &&
      prior?.transport === message?.transport
    ) add(prior);
  }
  return files;
}

export async function readModelFiles(files, ids, {
  remainingCharacters = MAX_FILE_CONTEXT_CHARACTERS,
} = {}) {
  if (
    !Array.isArray(ids) || !ids.length || ids.length > MAX_MODEL_FILES ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("invalid attachment read request");
  }
  // References are capabilities created for this turn, never caller-supplied paths.
  const selected = ids.map((id) => {
    const reference = files.find((file) => file.id === id);
    const verified = reference && fileReferences.get(reference);
    if (!verified) throw new Error("unknown attachment reference");
    return { reference, verified };
  });
  const results = [];
  let remaining = Math.max(0, Math.min(MAX_FILE_CONTEXT_CHARACTERS, remainingCharacters));
  for (const { reference, verified } of selected) {
    const result = {
      id: reference.id, filename: verified.filename, size: verified.size,
      status: verified.readableAsText ? "readable" : "unsupported_format",
    };
    if (!verified.readableAsText || remaining === 0) {
      if (remaining === 0) result.status = "context_limit";
      results.push(result);
      continue;
    }
    let handle;
    try {
      handle = await fs.open(verified.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (
        !info.isFile() || info.size !== verified.size ||
        info.dev !== verified.dev || info.ino !== verified.ino ||
        info.mtimeMs !== verified.mtimeMs
      ) {
        throw new Error("cached attachment changed before reading");
      }
      const buffer = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length) throw new Error("cached attachment read was incomplete");
      result.truncated = info.size > MAX_TEXT_BYTES;
      try {
        const decoded = decodeText(buffer, result.truncated);
        result.truncated ||= decoded.text.length > remaining;
        result.text = decoded.text.slice(0, remaining);
        result.encoding = decoded.encoding;
        remaining -= result.text.length;
      } catch {
        result.status = "unsupported_encoding_or_binary";
      }
    } catch {
      result.status = "file_read_failed";
    } finally {
      await handle?.close();
    }
    results.push(result);
  }
  return results;
}
