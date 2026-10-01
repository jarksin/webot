import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseControlCommand } from "../src/control-commands.js";

const root = path.resolve(import.meta.dirname, "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("README owner command table matches the command parser", () => {
  const section = readme.split("## Owner Slash Commands")[1]
    .split("## Self-Iteration")[0];
  const commands = [...section.matchAll(/^\| `(\/[^`]+)` \|/gm)]
    .map((match) => match[1]);
  assert.ok(commands.length >= 18);
  for (const command of commands) {
    const example = command
      .replaceAll("<name>", "demo")
      .replaceAll("<model>", "demo-model")
      .replaceAll("<level>", "high")
      .replaceAll("<task>", "example task");
    const parsed = parseControlCommand(example);
    assert.ok(parsed, `Undocumented parser support: ${command}`);
    assert.notEqual(parsed.action, "invalid", command);
  }
  assert.equal(parseControlCommand("/sessions").action, "list");
  assert.equal(parseControlCommand("/session list").action, "invalid");
  assert.equal(parseControlCommand("/restart"), null);
  assert.match(readme, /There is no `\/restart` slash command/);
});

test("README relative links and documentation illustrations exist", () => {
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !target.startsWith("#") && !/^[a-z]+:/i.test(target));
  assert.ok(links.includes("docs/assets/webot-admin-console.png"));
  assert.ok(links.includes("docs/assets/webot-architecture.svg"));
  for (const link of links) {
    assert.ok(fs.statSync(path.join(root, link)).isFile(), link);
  }
  const png = fs.readFileSync(path.join(root, "docs/assets/webot-admin-console.png"));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(png.readUInt32BE(16) >= 1000);
  assert.ok(png.readUInt32BE(20) >= 600);
  assert.match(readme, /fictional demonstration data/);
});

test("README distinguishes guarded automatic activation from manual restart", () => {
  assert.match(readme, /worker must \*\*never stop, signal, reinstall, or restart its own service/);
  assert.match(readme, /parent submits the exact committed candidate/);
  assert.match(readme, /There is no `\/restart` slash command/);
  assert.match(readme, /Confirmed console Restart.*Stops running tasks/);
  assert.match(readme, /accepted activation request.*passing\n+test run is not proof/);
  assert.match(readme, /do not restart/);
});
