import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { inject } from "postject";
import { DEFAULT_AGENTS_MD } from "../src/workspace-policy.js";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const seaNodeVersion = "22.22.0";
const target = `${process.platform}-${process.arch}`;
const name = `webot-v${packageJson.version}-${target}`;
const buildDir = path.join(root, ".build", "release");
const releaseDir = path.join(root, "dist", name);
const binary = path.join(releaseDir, "webot");
const bundle = path.join(buildDir, "webot.cjs");
const blob = path.join(buildDir, "sea-prep.blob");
const seaConfig = path.join(buildDir, "sea-config.json");
const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      stdio: options.quiet ? "pipe" : "inherit",
    });
    let stderr = "";
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs)
      : null;
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else if (timedOut) {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      }
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

async function codesignSettings() {
  const explicit = String(process.env.WEBOT_CODESIGN_IDENTITY || "").trim();
  const explicitKeychain = String(
    process.env.WEBOT_CODESIGN_KEYCHAIN || "",
  ).trim();
  return explicit
    ? { identity: explicit, keychain: explicitKeychain }
    : { identity: "-", keychain: "" };
}

async function hasSeaFuse(file) {
  try {
    return (await fs.readFile(file)).includes(Buffer.from(sentinel));
  } catch {
    return false;
  }
}

async function download(url, output) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
}

async function seaNodeExecutable() {
  const archiveName =
    `node-v${seaNodeVersion}-${process.platform}-${process.arch}.tar.gz`;
  const directoryName = archiveName.replace(/\.tar\.gz$/, "");
  const toolchainDir = path.join(root, ".build", "toolchain");
  const cached = path.join(toolchainDir, directoryName, "bin", "node");
  const candidates = [process.env.WEBOT_SEA_NODE, cached, process.execPath]
    .filter(Boolean);
  for (const candidate of candidates) {
    if (await hasSeaFuse(candidate)) return candidate;
  }
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("set WEBOT_SEA_NODE to an official Node.js executable");
  }
  await fs.mkdir(toolchainDir, { recursive: true });
  const base = `https://nodejs.org/dist/v${seaNodeVersion}`;
  const archive = path.join(toolchainDir, archiveName);
  const checksums = path.join(toolchainDir, "SHASUMS256.txt");
  await Promise.all([
    download(`${base}/${archiveName}`, archive),
    download(`${base}/SHASUMS256.txt`, checksums),
  ]);
  const expectedLine = (await fs.readFile(checksums, "utf8"))
    .split("\n")
    .find((line) => line.endsWith(`  ${archiveName}`));
  const actual = crypto
    .createHash("sha256")
    .update(await fs.readFile(archive))
    .digest("hex");
  if (!expectedLine || expectedLine.split(/\s+/)[0] !== actual) {
    throw new Error("official Node.js toolchain checksum mismatch");
  }
  await run("tar", ["-xzf", archive, "-C", toolchainDir]);
  if (!(await hasSeaFuse(cached))) {
    throw new Error("downloaded Node.js toolchain has no SEA fuse");
  }
  return cached;
}

await fs.rm(buildDir, { recursive: true, force: true });
await fs.rm(releaseDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(releaseDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "bin", "webot.js")],
  outfile: bundle,
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  define: {
    "process.env.WEBOT_VERSION": JSON.stringify(packageJson.version),
  },
});

const seaNode = await seaNodeExecutable();
await fs.writeFile(
  seaConfig,
  `${JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  )}\n`,
);
await run(seaNode, ["--experimental-sea-config", seaConfig]);
await fs.copyFile(seaNode, binary);
await fs.chmod(binary, 0o755);
await inject(binary, "NODE_SEA_BLOB", await fs.readFile(blob), {
  sentinelFuse: sentinel,
  machoSegmentName: "NODE_SEA",
});
if (process.platform === "darwin") {
  const { identity, keychain } = await codesignSettings();
  const identifier = String(
    process.env.WEBOT_CODESIGN_IDENTIFIER || "com.webot.agent",
  ).trim();
  const args = [
    "--sign",
    identity,
    "--force",
    "--identifier",
    identifier,
  ];
  if (keychain) args.push("--keychain", keychain);
  if (identity !== "-") {
    if (identity.startsWith("Developer ID Application:")) {
      args.push("--options", "runtime", "--timestamp");
    } else {
      args.push("--timestamp=none");
    }
  }
  args.push(binary);
  await run("codesign", args, { timeoutMs: 60_000 });
  process.stdout.write(
    `codesign identity: ${identity}${keychain ? " (Webot build keychain)" : ""}\n`,
  );
}

await Promise.all([
  fs.copyFile(
    path.join(root, "packaging", "install.sh"),
    path.join(releaseDir, "install.sh"),
  ),
  fs.copyFile(
    path.join(root, "packaging", "settings.example.json"),
    path.join(releaseDir, "settings.example.json"),
  ),
  fs.copyFile(path.join(root, "README.md"), path.join(releaseDir, "README.md")),
  fs.writeFile(
    path.join(releaseDir, "AGENTS.example.md"),
    DEFAULT_AGENTS_MD,
    { mode: 0o600 },
  ),
]);
await fs.mkdir(path.join(releaseDir, "scripts"), { recursive: true });
await fs.copyFile(
  path.join(root, "scripts", "telegram_bridge.py"),
  path.join(releaseDir, "scripts", "telegram_bridge.py"),
);
await fs.mkdir(path.join(releaseDir, "docs"), { recursive: true });
await fs.copyFile(
  path.join(root, "docs", "wechatpad-gateway.md"),
  path.join(releaseDir, "docs", "wechatpad-gateway.md"),
);
await fs.copyFile(
  path.join(root, "docs", "telegram.md"),
  path.join(releaseDir, "docs", "telegram.md"),
);
await fs.chmod(path.join(releaseDir, "install.sh"), 0o755);
await fs.chmod(path.join(releaseDir, "scripts", "telegram_bridge.py"), 0o755);

const files = [
  "webot",
  "install.sh",
  "settings.example.json",
  "README.md",
  "AGENTS.example.md",
  path.join("scripts", "telegram_bridge.py"),
  path.join("docs", "wechatpad-gateway.md"),
  path.join("docs", "telegram.md"),
];
const checksums = [];
for (const file of files) {
  const digest = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(releaseDir, file)))
    .digest("hex");
  checksums.push(`${digest}  ${file}`);
}
await fs.writeFile(
  path.join(releaseDir, "SHA256SUMS"),
  `${checksums.join("\n")}\n`,
);

const archive = path.join(root, "dist", `${name}.tar.gz`);
await run("tar", ["-czf", archive, "-C", path.dirname(releaseDir), name]);
process.stdout.write(`${archive}\n`);
