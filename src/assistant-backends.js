import fs from "node:fs";
import path from "node:path";

export function backendNames(config = {}) {
  return Object.keys(config.backends || {}).filter((name) =>
    /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) &&
    !["default", "reset", "auto", "list"].includes(name)
  );
}

export function backendName(config = {}, override = "") {
  return String(override || config.defaultBackend || "default").trim();
}

export function backendConfig(config = {}, override = "") {
  const name = backendName(config, override);
  if (name === "default" && !override) return config;
  if (!backendNames(config).includes(name)) {
    throw new Error("后端未配置，请用 /backend list 查看可用后端。");
  }
  const profile = config.backends[name];
  if (!profile || typeof profile.codexHome !== "string" ||
      !path.isAbsolute(profile.codexHome)) {
    throw new Error("后端缺少有效的本地 Codex 配置目录。");
  }
  const home = path.resolve(profile.codexHome);
  try {
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    const keys = ["OPENAI_API_KEY", ...Array.from(
      text.matchAll(/^\s*env_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gm),
      (match) => match[1],
    )];
    if (!auth || typeof auth !== "object" || Array.isArray(auth) ||
        (!keys.some((key) => typeof auth[key] === "string" && auth[key].trim()) &&
          !auth.tokens?.access_token)) {
      throw new Error("missing credentials");
    }
  } catch {
    throw new Error("后端配置或独立认证文件未就绪，未切换后端。");
  }
  return {
    ...config,
    codexHome: home,
    codexModel: String(profile.codexModel || config.codexModel || "").trim(),
    backendId: name,
    isolatedBackendAuth: true,
    cpaSshHost: String(profile.cpaSshHost || "").trim(),
  };
}
