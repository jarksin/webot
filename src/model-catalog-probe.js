import { spawn } from "node:child_process";
import { addModelCatalogEntries } from "./model-catalog-sync.js";

const REMOTE_SCRIPT = "/opt/cli-proxy-api/cpa-model-register.cjs";

function clean(value) {
  return String(value || "").trim();
}

function validModel(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(clean(value));
}

export function parseRegistrationOutput(stdout, stderr = "") {
  for (const content of [stdout, stderr]) {
    const lines = String(content || "").trim().split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const value = JSON.parse(lines[index]);
        if (value && typeof value === "object") return value;
      } catch {}
    }
  }
  throw new Error(clean(stderr || stdout || "invalid CPA model probe response").slice(0, 500));
}

export function runRemoteRegistration(model, env = process.env, options = {}) {
  const requested = clean(model);
  if (!validModel(requested)) {
    return Promise.reject(new Error(`invalid model: ${requested}`));
  }
  const sshHost = clean(
    options.sshHost
      || env.WEBOT_CPA_SSH_HOST
      || env.SEATALK_CPA_COMPANY_GATEWAY_SSH_HOST
      || "a30",
  );
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || 90_000));
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      sshHost,
      "sudo", "-n", "node", REMOTE_SCRIPT,
      "--model", requested,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CPA model probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 20_000) stdout = stdout.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      let result;
      try {
        result = parseRegistrationOutput(stdout, stderr);
      } catch (error) {
        reject(error);
        return;
      }
      if (code !== 0 || !result.ok) {
        reject(new Error(
          clean(result.error || stderr || `CPA model probe exited ${code}`).slice(0, 500),
        ));
        return;
      }
      resolve(result);
    });
  });
}

export async function probeAndAddModel(
  model,
  config = {},
  env = process.env,
  options = {},
) {
  const registration = await (options.runRemote || runRemoteRegistration)(
    model,
    env,
    options,
  );
  const exposedModels = Array.isArray(registration.exposed_models)
    ? registration.exposed_models.map(clean).filter(validModel)
    : [];
  if (!exposedModels.length) {
    throw new Error("CPA model probe returned no exposed models");
  }
  const catalog = await (options.addCatalog || addModelCatalogEntries)(
    exposedModels,
    config,
    env,
    options,
  );
  return {
    ...registration,
    added_models: catalog.addedModels,
    catalog_file: catalog.catalogFile,
    catalog_model_count: catalog.modelCount,
  };
}
