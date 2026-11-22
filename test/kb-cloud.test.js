import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KnowledgeBaseCloud } from "../src/kb-cloud.js";

const productMetadata = (version = "0.0.18") => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ version }),
});

test("specific API knowledge outranks general deployment mentions without leaking owner notes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-ranking-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const header = "---\napproved: true\naudience: public\n---\n";
  await fs.writeFile(path.join(directory, "a-install.md"),
    header + "# Installation\nCloud login. API runs on localhost.");
  await fs.writeFile(path.join(directory, "b-api.md"),
    header + "# Cloud API\nCall the hosted API with an account code.");
  await fs.writeFile(path.join(directory, "private.md"),
    "---\napproved: true\naudience: owner\n---\n# Cloud API\nPrivate secret.");
  const kb = new KnowledgeBaseCloud({
    enabled: true, localDir: directory, maxNotes: 1,
    maxCharsPerNote: 4000, requireApproved: true,
  });
  await kb.refreshLocalState();
  const result = await kb.search("cloud api", { access: "public" });
  assert.deepEqual(result.map((note) => note.path), ["b-api.md"]);
});

test("Chinese fragments retrieve procedures without numeric or frontmatter noise", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-chinese-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const header = "---\napproved: true\naudience: public\n---\n";
  await fs.writeFile(path.join(directory, "capacity.md"),
    header + "# 存储管理\n更改配额上限，延长租约。");
  await fs.writeFile(path.join(directory, "unrelated.md"),
    header + "# 排障\n错误码30，重试间隔5秒。");
  const kb = new KnowledgeBaseCloud({
    enabled: true, localDir: directory, maxNotes: 4,
    maxCharsPerNote: 4000, requireApproved: true,
  });
  await kb.refreshLocalState();
  for (const query of ["加配额", "把配额调到5", "延长30天"]) {
    const result = await kb.search(query);
    assert.deepEqual(result.map((note) => note.path), ["capacity.md"], query);
  }
  assert.deepEqual(await kb.search("30 5"), []);
  assert.deepEqual(await kb.search("approved public"), []);
});

test("metadata phrases rank first while approval and audience remain enforced", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-metadata-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const note = [
    "---", "approved: true", "audience: owner",
    'triggers: ["创建key", "延期"]',
    "aliases:", '  - "storage allocation"',
    'tags: "容量管理"', "---", "# Operations", "Follow the approved procedure.",
  ].join("\n");
  await fs.writeFile(path.join(directory, "operations.md"), note);
  await fs.writeFile(path.join(directory, "draft.md"), note.replace("approved: true", "approved: false"));
  await fs.writeFile(path.join(directory, "undeclared.md"), note.replace("audience: owner\n", ""));
  await fs.writeFile(path.join(directory, "general.md"),
    "---\napproved: true\naudience: public\n---\n# General\n创建 Key、延期、storage allocation、容量管理。");
  const kb = new KnowledgeBaseCloud({
    enabled: true, localDir: directory, maxNotes: 4,
    maxCharsPerNote: 4000, requireApproved: true,
  });
  await kb.refreshLocalState();
  for (const query of ["帮忙创建 Key", "延期30天", "STORAGE allocation", "容量管理"]) {
    const owner = await kb.search(query, { access: "owner" });
    assert.equal(owner[0].path, "operations.md", query);
    assert.ok(!owner.some((item) => item.path === "draft.md"));
    for (const access of ["public", "support", undefined]) {
      const visible = await kb.search(query, { access });
      assert.deepEqual(visible.map((item) => item.path), ["general.md"]);
    }
  }
  const document = await kb.readDocument("operations.md");
  await kb.writeDocument(document.file, document.content.replace("创建key", "archive storage"), {
    baseHash: document.hash,
  });
  assert.equal((await kb.search("archive storage", { access: "owner" }))[0].path, "operations.md");
});

test("long notes return relevant sections and deep matches within the character budget", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-excerpts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const header = "---\napproved: true\naudience: owner\n---\n";
  const content = "# Operations\nOnly act with authorization.\n\n" +
    "## Installation\n" + "Installation background.\n".repeat(100) +
    "\n## Storage\n" + "Storage background.\n".repeat(100) +
    "\nCapacity adjustment: verify the saved target before applying.\n";
  await fs.writeFile(path.join(directory, "operations.md"), header + content);
  await fs.writeFile(path.join(directory, "unsectioned.md"),
    header + "Background.\n".repeat(200) + "Capacity adjustment: unsectioned procedure.");
  const kb = new KnowledgeBaseCloud({
    enabled: true, localDir: directory, maxNotes: 2,
    maxCharsPerNote: 400, requireApproved: true,
  });
  await kb.refreshLocalState();
  const result = await kb.search("capacity adjustment", { access: "owner" });
  assert.equal(result.length, 2);
  for (const item of result) {
    assert.ok(item.content.length <= 400);
    assert.match(item.content, /Capacity adjustment:/);
    assert.match(item.content, /\[\.\.\.\]/);
  }
  assert.match(result.find((item) => item.path === "operations.md").content,
    /Only act with authorization/);
});

test("excerpt headings prefer a complete mixed-language phrase over scattered words", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-heading-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "operations.md"),
    "---\napproved: true\naudience: owner\n---\n# Operations\nAuthorized use only.\n\n" +
    "## 创建子 Key\nChild procedure.\n" + "Background.\n".repeat(100) +
    "\n## 创建 Key\nRoot procedure.\n");
  const kb = new KnowledgeBaseCloud({
    enabled: true, localDir: directory, maxNotes: 1,
    maxCharsPerNote: 300, requireApproved: true,
  });
  await kb.refreshLocalState();
  assert.match((await kb.search("创建key", { access: "owner" }))[0].content, /Root procedure/);
  assert.match((await kb.search("创建子key", { access: "owner" }))[0].content, /Child procedure/);
});

test("indexes approved markdown and returns bounded relevant notes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-"));
  await fs.writeFile(
    path.join(directory, "approved.md"),
    "---\napproved: true\naudience: owner\n---\nWebot 内部发布流程与二进制校验。",
  );
  await fs.writeFile(
    path.join(directory, "public.md"),
    "---\napproved: true\naudience: public\n---\nWebot 公开安装说明。",
  );
  await fs.writeFile(
    path.join(directory, "draft.md"),
    "Webot 未批准的发布草稿。",
  );
  const kb = new KnowledgeBaseCloud({
    enabled: true,
    remote: "",
    branch: "main",
    localDir: directory,
    syncIntervalSeconds: 900,
    maxNotes: 2,
    maxCharsPerNote: 20,
    requireApproved: true,
  }, { error() {} }, productMetadata());

  const sync = await kb.sync();
  const results = await kb.search("内部发布", { access: "owner" });
  assert.equal(sync.ready, true);
  assert.equal(sync.noteCount, 3);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "approved");
  assert.ok(results[0].content.length <= 20);

  const hidden = await kb.search("内部发布", { access: "public" });
  assert.equal(hidden.length, 0);
  const visible = await kb.search("公开安装", { access: "public" });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].audience, "public");
});

test("edits markdown documents with safe paths and optimistic locking", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-edit-"));
  const kb = new KnowledgeBaseCloud({
    enabled: false,
    remote: "",
    branch: "main",
    localDir: directory,
    syncIntervalSeconds: 900,
    maxNotes: 4,
    maxCharsPerNote: 4000,
    requireApproved: true,
  }, { error() {} }, productMetadata());

  const created = await kb.writeDocument(
    "owner/profile.md",
    "---\napproved: true\naudience: owner\n---\n# Profile\n",
  );
  assert.equal(created.file, "owner/profile.md");
  assert.equal(created.approved, true);
  assert.equal(created.audience, "owner");
  assert.equal((await kb.listDocuments()).length, 1);

  const updated = await kb.writeDocument(
    created.file,
    `${created.content}\nOwner prefers concise replies.\n`,
    { baseHash: created.hash },
  );
  assert.notEqual(updated.hash, created.hash);

  await assert.rejects(
    kb.writeDocument(created.file, "stale", { baseHash: created.hash }),
    (error) => error.code === "KB_CONFLICT",
  );
  await assert.rejects(
    kb.writeDocument("../escape.md", "# nope"),
    /invalid knowledge document path/,
  );
  assert.deepEqual(
    await kb.deleteDocument(updated.file, { baseHash: updated.hash }),
    { file: "owner/profile.md" },
  );
});

test("renders the official vxUltra version and keeps the last good value", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-kb-version-"));
  await fs.writeFile(
    path.join(directory, "version.md"),
    "---\napproved: true\naudience: public\n---\n# vxUltra\n当前版本 {{VXULTRA_VERSION}}。",
  );
  let fail = false;
  const kb = new KnowledgeBaseCloud({
    enabled: true,
    remote: "",
    branch: "main",
    localDir: directory,
    productMetadataUrl: "https://webot.win/health",
    syncIntervalSeconds: 900,
    maxNotes: 4,
    maxCharsPerNote: 4000,
    requireApproved: true,
  }, { error() {}, warn() {} }, async () => {
    if (fail) throw new Error("offline");
    return {
      ok: true,
      status: 200,
      json: async () => ({ version: "0.0.18" }),
    };
  });

  let status = await kb.sync();
  let results = await kb.search("当前版本", { access: "public" });
  assert.equal(status.productVersion, "0.0.18");
  assert.match(results[0].content, /当前版本 0\.0\.18/);
  assert.doesNotMatch(results[0].content, /\{\{VXULTRA_VERSION\}\}/);

  fail = true;
  status = await kb.sync();
  results = await kb.search("当前版本", { access: "public" });
  assert.equal(status.productVersion, "0.0.18");
  assert.match(status.productVersionError, /offline/);
  assert.match(results[0].content, /当前版本 0\.0\.18/);
});
