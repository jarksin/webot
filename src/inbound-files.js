import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const convertedArtifacts = new WeakMap();

export function isConversationConversion(artifact, message) {
  const scope = convertedArtifacts.get(artifact);
  return Boolean(scope && scope.transport && scope.sourceId && scope.chatId && scope.transport === message?.transport &&
    scope.sourceId === message?.sourceId && scope.chatId === message?.chatId);
}

const hydratedFiles = new WeakMap();
const fileReferences = new WeakMap();
export const MAX_MODEL_FILES = 6;
const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_FILE_CONTEXT_CHARACTERS = 128 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".tsv",
  ".yaml", ".yml", ".xml", ".log", ".ini", ".toml", ".rst",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go",
  ".sh", ".sql", ".html", ".htm", ".css",
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

export function modelFiles(message, mediaContext = [], existingFiles = []) {
  const files = [...existingFiles];
  const seen = new Set(files.map((file) => fileReferences.get(file)?.path));
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
        convertibleToMp3: path.extname(verified.filename).toLowerCase() === ".silk",
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

// Only framework-created references can reach the decoder. Models never supply paths,
// commands, codec flags, or output destinations. Outputs are fresh, private files.
export async function convertModelFiles(files, ids, { message, signal, run = runFile } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_MODEL_FILES ||
      new Set(ids).size !== ids.length) throw new Error("invalid audio conversion request");
  const selected = ids.map((id) => {
    const reference = files.find((file) => file.id === id);
    const verified = reference && fileReferences.get(reference);
    if (!verified) throw new Error("unknown attachment reference");
    return { reference, verified };
  });
  const results = [];
  const artifacts = [];
  for (const { reference, verified } of selected) {
    const result = { id: reference.id, filename: verified.filename };
    results.push(result);
    if (path.extname(verified.filename).toLowerCase() !== ".silk") {
      result.status = "unsupported_format";
      continue;
    }
    if (verified.size > 5 * 1024 * 1024) {
      result.status = "file_too_large";
      continue;
    }
    let handle;
    let directory;
    try {
      handle = await fs.open(verified.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size !== verified.size || info.dev !== verified.dev ||
          info.ino !== verified.ino || info.mtimeMs !== verified.mtimeMs) {
        throw new Error("cached attachment changed");
      }
      const data = await handle.readFile();
      const header = data[0] === 2 ? data.subarray(1, 10) : data.subarray(0, 9);
      if (header.toString("ascii") !== "#!SILK_V3") {
        result.status = "invalid_silk_header";
        continue;
      }
      directory = await fs.mkdtemp(path.join(path.dirname(verified.path), "converted-"));
      await fs.chmod(directory, 0o700);
      const input = path.join(directory, "input.silk");
      const pcm = path.join(directory, "audio.pcm");
      const output = path.join(directory, "audio.mp3");
      await fs.writeFile(input, data, { mode: 0o600 });
      const options = { timeout: 60_000, maxBuffer: 64 * 1024, signal };
      await run(process.env.WEBOT_AUDIO_PYTHON || "python3", ["-c",
        "import resource,sys,pilk; resource.setrlimit(resource.RLIMIT_FSIZE,(16777216,16777216)); pilk.decode(sys.argv[1],sys.argv[2],24000)",
        input, pcm], options);
      const decoded = await fs.stat(pcm);
      if (!decoded.size || decoded.size > 16 * 1024 * 1024) throw new Error("invalid PCM size");
      await run(process.env.WEBOT_FFMPEG || "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm,
        "-c:a", "libmp3lame", "-q:a", "4", output], options);
      const encoded = await fs.stat(output);
      if (!encoded.isFile() || !encoded.size || encoded.size > 5 * 1024 * 1024) {
        throw new Error("invalid MP3 size");
      }
      await fs.chmod(output, 0o600);
      const artifact = { path: output,
        filename: `${path.basename(verified.filename, path.extname(verified.filename))}.mp3`,
        kind: "file", mime: "audio/mpeg" };
      convertedArtifacts.set(artifact, {
        transport: message?.transport, sourceId: message?.sourceId, chatId: message?.chatId,
      });
      artifacts.push(artifact);
      Object.assign(result, { status: "converted", outputFilename: artifact.filename,
        durationSeconds: decoded.size / 48000, size: encoded.size,
        delivery: "Framework will attach this MP3 to your final reply automatically." });
      await fs.rm(input, { force: true });
      await fs.rm(pcm, { force: true });
    } catch (error) {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      if (signal?.aborted) throw error;
      result.status = error.code === "ENOENT" || /No module named/.test(String(error.stderr))
        ? "decoder_unavailable" : "conversion_failed";
    } finally {
      await handle?.close();
    }
  }
  return { results, artifacts };
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
