// Only framework-hydrated attachments can become native model image inputs.
// Persisted or sender-supplied localPath fields are deliberately not trusted.
const hydratedImages = new WeakMap();
export const MAX_MODEL_IMAGES = 6;

export function markHydratedImage(attachment, cached) {
  const result = { ...attachment, ...cached };
  if (result.kind === "image" && cached?.localPath) {
    hydratedImages.set(result, cached.localPath);
  }
  return result;
}

export function modelImages(message, mediaContext = []) {
  const images = [];
  const seen = new Set();
  function add(current) {
    for (const attachment of current?.attachments || []) {
      const imagePath = hydratedImages.get(attachment);
      if (!imagePath || seen.has(imagePath) || images.length >= MAX_MODEL_IMAGES) continue;
      seen.add(imagePath);
      images.push({ path: imagePath, messageId: String(current.messageId || "") });
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
  return images;
}

export function codexImageInput(prompt, images = []) {
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "localImage", path: image.path })),
  ];
}
