import fs from "node:fs";
import path from "node:path";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function clean(value) {
  return String(value || "").trim();
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function configValue(configText, name) {
  const pattern = new RegExp(
    `^\\s*${name}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`,
    "m",
  );
  return clean(pattern.exec(String(configText || ""))?.[1]);
}

function modelCatalogRuntime(config = {}, env = process.env) {
  const codexHome = path.resolve(
    clean(config.codexHome || env.WEBOT_CODEX_HOME || env.CODEX_HOME),
  );
  const configFile = path.join(codexHome, "config.toml");
  let configText = "";
  try {
    configText = fs.readFileSync(configFile, "utf8");
  } catch {}
  const configuredCatalog = configValue(configText, "model_catalog_json");
  return {
    codexHome,
    authFile: path.join(codexHome, "auth.json"),
    catalogFile: configuredCatalog
      ? path.resolve(codexHome, configuredCatalog)
      : "",
    baseUrl: configValue(configText, "openai_base_url"),
  };
}

function visibleTextModelId(value) {
  const id = clean(value);
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(id)
    && !id.includes("/")
    && !/^(?:codex-auto-review|gpt-reserve|gpt-image-)/i.test(id);
}

export function visibleTextModelIds(payload = {}) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return [...new Set(models
    .map((entry) => clean(entry?.id))
    .filter(visibleTextModelId))];
}

function commonPrefixScore(left, right) {
  const a = clean(left).replace(/^company-/, "").split(/[-_.]+/);
  const b = clean(right).replace(/^company-/, "").split(/[-_.]+/);
  let score = 0;
  while (score < a.length && score < b.length && a[score] === b[score]) {
    score += 1;
  }
  return score;
}

function usableTemplate(models, id) {
  const usable = models.filter((entry) =>
    typeof entry?.base_instructions === "string"
    && entry.base_instructions.trim()
  );
  const exact = usable.find((entry) => clean(entry.slug) === id);
  if (exact) return exact;
  const baseId = id.replace(/^company-/, "");
  const base = usable.find((entry) => clean(entry.slug) === baseId);
  if (base) return base;
  return usable
    .map((entry, index) => ({
      entry,
      index,
      score: commonPrefixScore(entry.slug, id),
    }))
    .sort((left, right) =>
      right.score - left.score || left.index - right.index
    )[0]?.entry;
}

export function catalogForModelIds(
  existingCatalog = {},
  modelIds = [],
  fetchedAt = new Date().toISOString(),
) {
  const existingModels = Array.isArray(existingCatalog?.models)
    ? existingCatalog.models
    : [];
  if (modelIds.length && !usableTemplate(existingModels, modelIds[0])) {
    throw new Error("current Codex catalog has no reusable model metadata");
  }
  const priorities = new Map(existingModels.map((entry, index) => [
    clean(entry?.slug),
    Number.isFinite(Number(entry?.priority))
      ? Number(entry.priority)
      : 10_000 + index,
  ]));
  const ordered = [...modelIds].sort((left, right) => {
    const leftPriority = priorities.get(left) ?? 100_000;
    const rightPriority = priorities.get(right) ?? 100_000;
    return leftPriority - rightPriority || left.localeCompare(right);
  });
  const models = ordered.map((id, index) => {
    const template = usableTemplate(existingModels, id);
    if (!template) throw new Error(`no reusable Codex metadata for ${id}`);
    const entry = structuredClone(template);
    entry.slug = id;
    entry.display_name = id;
    entry.description = `${id} (custom provider)`;
    entry.visibility = "list";
    entry.priority = priorities.get(id) ?? 1000 + index;
    return entry;
  });
  return {
    ...existingCatalog,
    fetched_at: fetchedAt,
    models,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export async function refreshModelCatalog(
  config = {},
  env = process.env,
  options = {},
) {
  const runtime = modelCatalogRuntime(config, env);
  if (!runtime.catalogFile || !runtime.baseUrl) {
    return { enabled: false, reason: "custom catalog or provider URL is not configured" };
  }
  const auth = readJson(runtime.authFile);
  const apiKey = clean(env.OPENAI_API_KEY || auth.OPENAI_API_KEY);
  if (!apiKey) throw new Error("custom provider model sync has no API key");
  const response = await (options.fetch || globalThis.fetch)(
    `${runtime.baseUrl.replace(/\/+$/, "")}/models`,
    {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Number(options.timeoutMs || 10_000)),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`custom provider model list returned HTTP ${response.status}`);
  }
  const models = visibleTextModelIds(body);
  if (!models.length) {
    throw new Error("custom provider returned no visible text models");
  }
  const catalog = catalogForModelIds(readJson(runtime.catalogFile), models);
  writeJsonAtomic(runtime.catalogFile, catalog);
  return {
    enabled: true,
    catalogFile: runtime.catalogFile,
    modelCount: models.length,
    models,
    fetchedAt: catalog.fetched_at,
  };
}

export function createModelCatalogSync(
  config = {},
  env = process.env,
  options = {},
) {
  const intervalMs = Math.max(
    60_000,
    Number(options.intervalMs || env.WEBOT_MODEL_CATALOG_SYNC_INTERVAL_MS
      || DEFAULT_INTERVAL_MS),
  );
  const state = {
    enabled: true,
    running: false,
    lastSuccessAt: "",
    lastErrorAt: "",
    lastError: "",
    modelCount: 0,
    models: [],
  };
  let timer = null;
  let inFlight = null;

  async function refresh() {
    if (inFlight) return inFlight;
    state.running = true;
    inFlight = refreshModelCatalog(config, env, options).then((result) => {
      state.enabled = result.enabled;
      if (!result.enabled) {
        state.lastError = "";
        return status();
      }
      state.lastSuccessAt = result.fetchedAt;
      state.lastError = "";
      state.modelCount = result.modelCount;
      state.models = result.models;
      options.logger?.info?.("custom model catalog synced", {
        modelCount: result.modelCount,
      });
      return status();
    }).catch((error) => {
      state.lastErrorAt = new Date().toISOString();
      state.lastError = clean(error?.message || error).slice(0, 500);
      options.logger?.warn?.("custom model catalog sync failed", {
        error: state.lastError,
      });
      return status();
    }).finally(() => {
      state.running = false;
      inFlight = null;
    });
    return inFlight;
  }

  function start() {
    if (timer || env.WEBOT_MODEL_CATALOG_SYNC === "0") return;
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function status() {
    return { ...state, models: [...state.models] };
  }

  return { refresh, start, stop, status };
}
