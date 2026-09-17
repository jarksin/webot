import fs from "node:fs";
import path from "node:path";
import { codexRuntimeStatus } from "./codex-provider.js";
import {
  normalizeSessionName,
  parseSessionCommand,
  validSessionName,
} from "./named-sessions.js";

const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);

function clean(value) {
  return String(value || "").trim();
}

function validModel(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/.test(clean(value));
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function catalogModels(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(value?.models) ? value.models : [])
      .map((entry) => clean(entry?.slug))
      .filter(validModel)
      .filter((model) => !/^(?:gpt-image-|codex-auto-review$)/i.test(model));
  } catch {
    return [];
  }
}

export function availableModels(config = {}, env = process.env) {
  const runtime = codexRuntimeStatus(config, env);
  const configuredCatalog = clean(runtime.localConfig.model_catalog_json);
  const catalogFiles = [
    path.join(runtime.home, "models_cache.json"),
    configuredCatalog
      ? (path.isAbsolute(configuredCatalog)
          ? configuredCatalog
          : path.join(runtime.home, configuredCatalog))
      : "",
  ].filter(Boolean);
  const catalog = catalogFiles.flatMap(catalogModels);
  return unique([
    runtime.effective.model,
    runtime.localConfig.model,
    ...catalog,
  ]);
}

export function parseControlCommand(value) {
  const text = clean(value);
  if (!text.startsWith("/")) return null;
  const session = parseSessionCommand(text);
  if (session) return session;
  if (
    /^\/(?:models|modes)\s*$/i.test(text)
    || /^\/model\s+list\s*$/i.test(text)
  ) {
    return { type: "model", action: "list" };
  }
  const model = text.match(/^\/model(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i);
  if (model) {
    const argument = clean(model[1]);
    const task = clean(model[2]);
    if (!argument) return { type: "model", action: "show" };
    if (/^(?:default|reset|auto)$/i.test(argument)) {
      return { type: "model", action: "reset", task };
    }
    return { type: "model", action: "set", model: argument, task };
  }
  const effort = text.match(/^\/effort(?:\s+(\S+))?\s*$/i);
  if (effort) {
    const argument = clean(effort[1]).toLowerCase();
    if (!argument) return { type: "effort", action: "show" };
    if (/^(?:default|reset|auto)$/i.test(argument)) {
      return { type: "effort", action: "reset" };
    }
    return { type: "effort", action: "set", effort: argument };
  }
  if (/^\/(?:clear|new|reset)(?:\s+(?:session|case))?\s*$/i.test(text)) {
    return { type: "clear", action: "reset" };
  }
  if (/^\/stop(?:\s+(?:worker|task|case|任务))?\s*$/i.test(text)) {
    return { type: "stop", action: "stop" };
  }
  if (/^\/status\s*$/i.test(text)) return { type: "status", action: "show" };
  if (/^\/help\s*$/i.test(text)) return { type: "help", action: "show" };
  return null;
}

export function modelRuntimeKey(caseId) {
  return `assistant_model:${clean(caseId)}`;
}

export function effortRuntimeKey(caseId) {
  return `assistant_effort:${clean(caseId)}`;
}

export function runtimeOverrides(caseStore, caseId) {
  return {
    model: caseStore.runtimeSetting(modelRuntimeKey(caseId), ""),
    reasoningEffort: caseStore.runtimeSetting(effortRuntimeKey(caseId), ""),
  };
}

function effectiveRuntime(caseStore, caseId, config, env) {
  const base = codexRuntimeStatus(config, env).effective;
  const overrides = runtimeOverrides(caseStore, caseId);
  return {
    model: overrides.model || base.model || "default",
    reasoningEffort: overrides.reasoningEffort || base.reasoningEffort || "default",
    serviceTier: base.serviceTier || "default",
    modelSource: overrides.model ? "session" : "default",
    effortSource: overrides.reasoningEffort ? "session" : "default",
  };
}

export async function applyControlCommand({
  command,
  caseId,
  scopeCaseId = caseId,
  caseStore,
  sessionStore,
  config,
  env = process.env,
  stopped = false,
}) {
  const runtime = effectiveRuntime(caseStore, caseId, config, env);
  if (command.type === "session") {
    const current = caseStore.ensureSessionScope(scopeCaseId);
    if (command.action === "invalid") {
      return {
        text:
          "命令格式不对。使用 /session new <名称>、/session <名称>、"
          + "/session delete <名称> 或 /sessions。",
      };
    }
    if (command.action === "show") {
      return {
        text:
          `当前 session：${current.name}。\n`
          + "新建：/session new <名称>；切换：/session <名称>；"
          + "删除：/session delete <名称>；列表：/sessions；"
          + "切回默认：/session main。",
      };
    }
    if (command.action === "list") {
      const sessions = caseStore.listSessions(scopeCaseId);
      const names = sessions
        .map((item) => `${item.is_active ? "*" : "-"} ${item.name}`)
        .join("\n");
      return { text: `Sessions：\n${names}\n\n切回默认：/session main` };
    }
    if (command.action === "new") {
      try {
        const created = caseStore.createSession(scopeCaseId, command.name);
        return {
          text:
            `已新建并切换到 session「${created.name}」。`
            + "该 session 的上下文、Codex session、模型和 effort 均独立。",
        };
      } catch (error) {
        return { text: `${error.message}。用 /sessions 查看现有 session。` };
      }
    }
    if (command.action === "delete") {
      const name = normalizeSessionName(command.name);
      if (!validSessionName(name)) {
        return {
          text: "请指定要删除的 session，例如 /session delete project-a。",
        };
      }
      const deleted = caseStore.deleteSession(scopeCaseId, name);
      if (deleted.reason === "not-found") {
        return { text: `找不到 session「${name}」。用 /sessions 查看。` };
      }
      if (deleted.reason === "main") {
        return { text: "默认 session「main」不能删除。" };
      }
      if (deleted.reason === "active") {
        return {
          text: `不能删除当前 session「${deleted.session.name}」，请先切换到其他 session。`,
        };
      }
      return {
        text: `已删除 session「${deleted.session.name}」，历史记录仍保存在本地。`,
      };
    }
    const name = normalizeSessionName(command.name);
    if (!validSessionName(name)) {
      return { text: "请指定要切换的 session，例如 /session main。" };
    }
    const selected = caseStore.activateSession(scopeCaseId, name);
    if (!selected) {
      return { text: `找不到 session「${name}」。用 /sessions 查看。` };
    }
    return {
      text: selected.session_id === "main"
        ? "已切回默认 session「main」。"
        : `已切换到 session「${selected.name}」。`,
    };
  }

  if (command.type === "model") {
    if (command.action === "list") {
      const models = availableModels(config, env);
      return {
        text: `当前模型：${runtime.model}\n\n可用模型：${models.join("、") || "未读取到本地模型目录"}`,
      };
    }
    if (command.action === "show") {
      return { text: `当前模型：${runtime.model}` };
    }
    if (command.action === "reset") {
      caseStore.deleteRuntimeSetting(modelRuntimeKey(caseId));
      const restored = effectiveRuntime(caseStore, caseId, config, env);
      if (command.task) {
        return { continueText: command.task, model: restored.model };
      }
      return { text: `已清除会话模型覆盖，恢复为：${restored.model}` };
    }
    const models = availableModels(config, env);
    const canonical = models.find(
      (model) => model.toLowerCase() === clean(command.model).toLowerCase(),
    );
    if (!canonical) {
      return {
        text: `模型 ${clean(command.model) || "参数"} 不可用。可选：${models.join("、") || "未读取到本地模型目录"}`,
      };
    }
    caseStore.setRuntimeSetting(modelRuntimeKey(caseId), canonical);
    if (command.task) return { continueText: command.task, model: canonical };
    return { text: `当前会话已切换到 ${canonical}，下一条任务开始生效。` };
  }

  if (command.type === "effort") {
    if (command.action === "show") {
      return { text: `当前 reasoning effort：${runtime.reasoningEffort}` };
    }
    if (command.action === "reset") {
      caseStore.deleteRuntimeSetting(effortRuntimeKey(caseId));
      const restored = effectiveRuntime(caseStore, caseId, config, env);
      return {
        text: `已清除会话 effort 覆盖，恢复为：${restored.reasoningEffort}`,
      };
    }
    if (!EFFORTS.includes(command.effort)) {
      return {
        text: `effort ${command.effort || "参数"} 不可用。可选：${EFFORTS.join("、")}`,
      };
    }
    caseStore.setRuntimeSetting(effortRuntimeKey(caseId), command.effort);
    return {
      text: `当前会话 reasoning effort 已切换到 ${command.effort}，下一条任务开始生效。`,
    };
  }

  if (command.type === "clear") {
    caseStore.resetCodexSession(caseId);
    caseStore.deleteRuntimeSetting(modelRuntimeKey(caseId));
    caseStore.deleteRuntimeSetting(effortRuntimeKey(caseId));
    await sessionStore.clear(caseId);
    const restored = effectiveRuntime(caseStore, caseId, config, env);
    return {
      text: `已清理当前会话，下一条消息会创建新的 Codex session。当前模型：${restored.model}。`,
    };
  }

  if (command.type === "stop") {
    return { text: "任务已停止" };
  }

  if (command.type === "status") {
    const session = caseStore.sessionForTarget(caseId);
    return {
      text:
        `当前 session：${session?.name || "main"}\n`
        + `当前模型：${runtime.model}（${runtime.modelSource}）\n`
        + `Reasoning：${runtime.reasoningEffort}（${runtime.effortSource}）\n`
        + `Service tier：${runtime.serviceTier}`,
    };
  }

  return {
    text:
      "会话：/session、/sessions、/session new <名称>、"
      + "/session <名称>、/session delete <名称>。\n"
      + "运行：/models、/model [模型|default]、/effort [级别|default]、"
      + "/status、/clear、/stop。\n"
      + "也可用 /model <模型> <任务> 直接指定下一项任务。",
  };
}
