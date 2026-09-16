import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KnowledgeBaseCloud } from "../src/kb-cloud.js";

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
  }, { error() {} });

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
  }, { error() {} });

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
