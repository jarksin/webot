// QW structured content is independent of the personal WeChat XML dialect.
export const QW_FILE_ENDPOINT = "/api/v1/files/download";
export const QW_MAX_FILE_BYTES = 64 * 1024 * 1024;

export function qwFileMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.filename === "string" && value.filename.trim() &&
    typeof value.size === "string" && /^(0|[1-9]\d{0,19})$/.test(value.size) &&
    BigInt(value.size) <= 18446744073709551615n &&
    (value.file_id === undefined || typeof value.file_id === "string");
}

export function qwLinkMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.title !== "string" || typeof value.url !== "string" ||
    (value.description !== undefined && typeof value.description !== "string") ||
    !/^https?:\/\//i.test(value.url) || /[\x00-\x20\\]/.test(value.url)) return null;
  try {
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password) return null;
  } catch { return null; }
  return {
    title: value.title, url: value.url,
    ...(value.description === undefined ? {} : { description: value.description }),
  };
}

export function qwFileDownload(metadata, download) {
  if (!qwFileMetadata(metadata) || !download || typeof download !== "object" ||
    Array.isArray(download) || typeof download.fileid !== "string" || !download.fileid ||
    typeof download.aes_key !== "string" || !/^[a-f0-9]{32}$/i.test(download.aes_key) ||
    download.filetype !== 5 || typeof download.file_name !== "string" ||
    download.file_name !== metadata.filename || !Number.isSafeInteger(download.size) ||
    download.size <= 0 || download.size > QW_MAX_FILE_BYTES ||
    String(download.size) !== metadata.size) return null;
  // The external locator remains an opaque capability sent to the QW gateway.
  // Webot never fetches it or attaches either credential to an external request.
  const external = download.authkey !== undefined ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(download.fileid.trim()) || download.fileid.trim().startsWith("//");
  if (external) {
    if (!/^https:\/\/imunion\.weixin\.qq\.com(?:[/?]|$)/.test(download.fileid) ||
      /[\s\p{Cc}\\#]/u.test(download.fileid) || typeof download.authkey !== "string" ||
      !download.authkey || Buffer.byteLength(download.authkey, "utf8") > 64 * 1024 ||
      /\p{Cc}/u.test(download.authkey)) return null;
    try {
      const url = new URL(download.fileid);
      if (url.protocol !== "https:" || url.hostname !== "imunion.weixin.qq.com" ||
        url.username || url.password || url.port || url.hash) return null;
    } catch { return null; }
  }
  return {
    fileid: download.fileid, aes_key: download.aes_key, filetype: download.filetype,
    size: download.size, file_name: download.file_name,
    ...(external ? { authkey: download.authkey } : {}),
  };
}

export function qwContent(message) {
  if (message.kind === "text") return { type: 1, text: String(message.content || ""), attachments: [] };
  if (message.kind === "file" && qwFileMetadata(message.media)) {
    const media = message.media;
    const download = qwFileDownload(media, media.download);
    return {
      type: 49, text: media.filename, attachments: [{
        kind: "file", filename: media.filename, size: media.size,
        ...(media.file_id ? { fileId: media.file_id } : {}),
        ...(download ? { downloadContext: { endpoint: QW_FILE_ENDPOINT, ...download } }
          : { error: "file_download_context_missing" }),
      }],
    };
  }
  const link = message.kind === "link" && qwLinkMetadata(message.link);
  if (link) return {
    type: 49, text: [link.title, link.description, link.url].filter(Boolean).join("\n"),
    attachments: [], link,
  };
  return { type: NaN, text: "", attachments: [] };
}
