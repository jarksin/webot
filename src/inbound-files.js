import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const hydratedFiles = new WeakMap();
export const MAX_MODEL_FILES = 6;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_CONTEXT_CHARACTERS = 128 * 1024;
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
  if (attachment?.kind !== "file" || !cached?.localPath) return result;
  delete result.error;
  const filename = String(attachment.filename || cached.filename || "file");
  const file = { filename, size: cached.size, status: "unsupported_format" };
  if (
    TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()) ||
    String(attachment.mime || cached.mime || "").toLowerCase().startsWith("text/")
  ) {
    const handle = await fs.open(cached.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== cached.size) {
        throw new Error("cached attachment changed before reading");
      }
      const buffer = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length) throw new Error("cached attachment read was incomplete");
      file.truncated = info.size > MAX_TEXT_BYTES;
      try {
        Object.assign(file, decodeText(buffer, file.truncated), { status: "readable" });
      } catch {
        file.status = "unsupported_encoding_or_binary";
      }
    } finally {
      await handle.close();
    }
  }
  // Only framework-validated attachments contribute content, never inbound paths or text fields.
  hydratedFiles.set(result, file);
  return result;
}

export function modelFiles(message, mediaContext = []) {
  const files = [];
  const seen = new Set();
  let remaining = MAX_CONTEXT_CHARACTERS;
  function add(current) {
    for (const attachment of current?.attachments || []) {
      const verified = hydratedFiles.get(attachment);
      if (!verified || seen.has(attachment.localPath) || files.length >= MAX_MODEL_FILES) continue;
      seen.add(attachment.localPath);
      const file = { ...verified, messageId: String(current.messageId || "") };
      if (typeof file.text === "string") {
        file.truncated ||= file.text.length > remaining;
        file.text = file.text.slice(0, remaining);
        remaining -= file.text.length;
      }
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
