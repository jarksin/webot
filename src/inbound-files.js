import fs from "node:fs/promises";
import { markHydratedImage } from "./inbound-images.js";
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
  const result = attachment?.kind === "image"
    ? markHydratedImage(attachment, cached) : { ...attachment, ...cached };
  if (!["file", "video", "image"].includes(attachment?.kind) || !cached?.localPath) return result;
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
        processingOperations: ATTACHMENT_OPERATIONS,
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


// Fixed recipes operate on verified conversation capabilities, never model paths,
// URLs, scripts, codec arguments, or output destinations.
export const ATTACHMENT_OPERATIONS = Object.freeze([
  "decode_base64", "encode_base64", "format_json", "text_utf8",
  "image_png", "image_jpg", "image_webp", "audio_mp3", "audio_wav", "video_mp4",
]);
const MAX_PROCESS_BYTES = 20 * 1024 * 1024;

function binaryType(data) {
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp") return ["mp4", "video/mp4", "mov"];
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ["png", "image/png", "png_pipe"];
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return ["jpg", "image/jpeg", "jpeg_pipe"];
  if (/^GIF8[79]a/.test(data.toString("ascii", 0, 6))) return ["gif", "image/gif", "gif"];
  if (data.toString("ascii", 0, 4) === "RIFF") {
    if (data.toString("ascii", 8, 12) === "WEBP") return ["webp", "image/webp", "webp_pipe"];
    if (data.toString("ascii", 8, 12) === "WAVE") return ["wav", "audio/wav", "wav"];
  }
  if (data.toString("ascii", 0, 3) === "ID3" || (data[0] === 255 && (data[1] & 224) === 224)) return ["mp3", "audio/mpeg", "mp3"];
  if (data.toString("ascii", 0, 4) === "OggS") return ["ogg", "audio/ogg", "ogg"];
  if (data.toString("ascii", 0, 4) === "fLaC") return ["flac", "audio/flac", "flac"];
  if (data.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return ["webm", "video/webm", "matroska"];
  if (data.toString("ascii", 0, 4) === "%PDF") return ["pdf", "application/pdf", ""];
  if (data[0] === 80 && data[1] === 75 && data[2] === 3 && data[3] === 4) return ["zip", "application/zip", ""];
  return ["bin", "application/octet-stream", ""];
}

function base64Bytes(text, field) {
  let value = text.trim();
  try {
    let object = JSON.parse(value);
    const keys = field ? field.split(".") : null;
    if (keys) {
      for (const key of keys) {
        if (!object || typeof object !== "object" || !Object.hasOwn(object, key)) throw new Error("missing data field");
        object = object[key];
      }
      value = object;
    } else if (typeof object === "string") value = object;
    else value = object?.Data?.data ?? object?.data?.data ?? object?.data;
  } catch (error) {
    if (field || /^[{[]/.test(value)) throw error;
  }
  if (typeof value !== "string") throw new Error("missing base64 string");
  value = value.replace(/^data:[^,;]*;base64,/, "").replace(/\s/g, "");
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("invalid base64");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new Error("invalid base64");
  return data;
}

export async function processModelFiles(files, requests, { message, signal, run = runFile } = {}) {
  if (!Array.isArray(requests) || !requests.length || requests.length > MAX_MODEL_FILES ||
      new Set(requests.map((item) => item?.id)).size !== requests.length) throw new Error("invalid attachment processing request");
  const selected = requests.map((request) => {
    if (!request || Object.keys(request).some((key) => !["id", "operation", "field"].includes(key)) ||
        !ATTACHMENT_OPERATIONS.includes(request.operation) ||
        (request.field !== undefined && (request.operation !== "decode_base64" || typeof request.field !== "string" ||
          !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,7}$/.test(request.field)))) throw new Error("invalid attachment processing request");
    const reference = files.find((file) => file.id === request.id);
    const verified = reference && fileReferences.get(reference);
    if (!verified) throw new Error("unknown attachment reference");
    return { request, verified };
  });
  const results = [], artifacts = [];
  for (const { request, verified } of selected) {
    if (signal?.aborted) throw new Error("attachment processing aborted");
    const result = { id: request.id, operation: request.operation, filename: verified.filename };
    results.push(result);
    if (verified.size > MAX_PROCESS_BYTES) { result.status = "file_too_large"; continue; }
    let handle, directory;
    try {
      handle = await fs.open(verified.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size !== verified.size || info.dev !== verified.dev ||
          info.ino !== verified.ino || info.mtimeMs !== verified.mtimeMs) throw new Error("attachment changed");
      const data = await handle.readFile();
      let outputData, type;
      if (request.operation === "decode_base64") {
        outputData = base64Bytes(decodeText(data, false).text, request.field);
        type = binaryType(outputData);
      } else if (request.operation === "encode_base64") {
        outputData = Buffer.from(data.toString("base64")); type = ["base64.txt", "text/plain"];
      } else if (request.operation === "format_json") {
        outputData = Buffer.from(JSON.stringify(JSON.parse(decodeText(data, false).text), null, 2) + "\n");
        type = ["json", "application/json"];
      } else if (request.operation === "text_utf8") {
        outputData = Buffer.from(decodeText(data, false).text); type = ["txt", "text/plain"];
      }
      if (outputData && (!outputData.length || outputData.length > MAX_PROCESS_BYTES)) throw new Error("invalid output size");
      directory = await fs.mkdtemp(path.join(path.dirname(verified.path), "processed-"));
      await fs.chmod(directory, 0o700);
      if (!outputData) {
        const inputType = binaryType(data);
        if (!inputType[2]) { result.status = "unsupported_format"; await fs.rm(directory, { recursive: true, force: true }); continue; }
        const recipes = {
          image_png: ["png", "image/png", ["-frames:v", "1", "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease", "-c:v", "png"]],
          image_jpg: ["jpg", "image/jpeg", ["-frames:v", "1", "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease", "-c:v", "mjpeg"]],
          image_webp: ["webp", "image/webp", ["-frames:v", "1", "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease", "-c:v", "png"]],
          audio_mp3: ["mp3", "audio/mpeg", ["-vn", "-c:a", "libmp3lame", "-b:a", "128k"]],
          audio_wav: ["wav", "audio/wav", ["-vn", "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1"]],
          video_mp4: ["mp4", "video/mp4", ["-map", "0:v:0", "-map", "0:a?", "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]],
        };
        type = recipes[request.operation];
        const input = path.join(directory, "input." + inputType[0]);
        await fs.writeFile(input, data, { mode: 0o600 });
        const output = path.join(directory, "output." + (request.operation === "image_webp" ? "png" : type[0]));
        await run(process.env.WEBOT_FFMPEG || "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error",
          "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-f", inputType[2],
          "-threads", "1", "-i", input, "-threads", "1", "-filter_threads", "1", "-t", "300",
          "-map_metadata", "-1", ...type[2], "-fs", String(MAX_PROCESS_BYTES), output],
        { timeout: 60_000, maxBuffer: 64 * 1024, signal });
        if (request.operation === "image_webp") {
          const webp = path.join(directory, "output.webp");
          await run(process.env.WEBOT_FILE_PYTHON || "python3", ["-c",
            "import resource,sys; from PIL import Image; resource.setrlimit(resource.RLIMIT_FSIZE,(20971520,20971520)); Image.MAX_IMAGE_PIXELS=4000000; im=Image.open(sys.argv[1]); im.save(sys.argv[2],format='WEBP')",
            output, webp], { timeout: 60_000, maxBuffer: 64 * 1024, signal });
          outputData = await fs.readFile(webp);
          await fs.rm(webp, { force: true });
        } else outputData = await fs.readFile(output);
        await fs.rm(input, { force: true });
        await fs.rm(output, { force: true });
      }
      if (!outputData.length || outputData.length >= MAX_PROCESS_BYTES - 65536) throw new Error("invalid output size");
      const output = path.join(directory, "result." + type[0]);
      await fs.writeFile(output, outputData, { mode: 0o600 });
      const artifact = { path: output, filename: path.basename(verified.filename, path.extname(verified.filename)) + "." + type[0], kind: "file", mime: type[1] };
      convertedArtifacts.set(artifact, { transport: message?.transport, sourceId: message?.sourceId, chatId: message?.chatId });
      artifacts.push(artifact);
      Object.assign(result, { status: "converted", outputFilename: artifact.filename, size: outputData.length,
        delivery: "Framework will attach this file to your final reply automatically.",
        ...(request.operation.startsWith("audio_") || request.operation.startsWith("video_") ? { maxDurationSeconds: 300 } : {}) });
    } catch (error) {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      if (signal?.aborted) throw error;
      result.status = error.code === "ENOENT" ? "processor_unavailable" : "processing_failed";
    } finally { await handle?.close(); }
  }
  return { results, artifacts };
}
