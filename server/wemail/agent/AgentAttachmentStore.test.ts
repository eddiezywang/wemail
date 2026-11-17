import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { openOrCreateMailDatabase } from "../database/Database.js";
import {
  AgentAttachmentError,
  AgentAttachmentStore,
} from "./AgentAttachmentStore.js";

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-attachments-"));
  const root = path.join(directory, "managed");
  const db = openOrCreateMailDatabase(path.join(directory, "wemail.sqlite"));
  let now = new Date("2026-08-02T10:00:00.000Z");
  const store = new AgentAttachmentStore(db, root, () => now);
  return {
    db,
    root,
    directory,
    store,
    setNow(value: string) { now = new Date(value); },
    cleanup() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test("local and mail intake share deterministic atomic storage with account isolation", async () => {
  const h = harness();
  try {
    const localPath = path.join(h.directory, "notes.md");
    fs.writeFileSync(localPath, "# Notes\nApproved", "utf8");
    const [first, concurrent] = await Promise.all([
      h.store.intake("account-a", { type: "local", filePath: localPath }),
      h.store.intake("account-a", { type: "local", filePath: localPath }),
    ]);
    assert.equal(first.id, concurrent.id);
    assert.equal(first.relativePath, concurrent.relativePath);
    assert.equal(first.relativePath.includes("account-a"), false);
    assert.equal(fs.existsSync(path.join(h.root, ...first.relativePath.split("/"))), true);
    assert.equal(
      (h.db.prepare("SELECT count(*) AS count FROM agent_attachments").get() as { count: number }).count,
      1,
    );

    const reused = await h.store.intake("account-a", { type: "local", filePath: localPath });
    assert.equal(reused.reused, true);
    const otherAccount = await h.store.intake("account-b", { type: "local", filePath: localPath });
    assert.notEqual(otherAccount.id, first.id);
    assert.notEqual(otherAccount.relativePath, first.relativePath);

    let mailLoads = 0;
    const mail = await h.store.intake("account-a", {
      type: "mail",
      emailId: "mail-1",
      attachmentId: "part-1",
      name: "source.txt",
      mediaType: "text/plain",
      load: async () => { mailLoads += 1; return Buffer.from("mail attachment"); },
    });
    const mailAgain = await h.store.intake("account-a", {
      type: "mail",
      emailId: "mail-1",
      attachmentId: "part-1",
      name: "source.txt",
      mediaType: "text/plain",
      load: async () => { mailLoads += 1; return Buffer.from("should not load"); },
    });
    assert.equal(mail.id, mailAgain.id);
    assert.equal(mailLoads, 1);
  } finally {
    h.cleanup();
  }
});

test("intake rejects excluded formats and send-time integrity changes", async () => {
  const h = harness();
  try {
    const zipPath = path.join(h.directory, "archive.zip");
    fs.writeFileSync(zipPath, "not a zip");
    await assert.rejects(
      h.store.intake("account-a", { type: "local", filePath: zipPath }),
      (error: unknown) => error instanceof AgentAttachmentError && error.code === "attachment-format-unsupported",
    );

    const textPath = path.join(h.directory, "safe.txt");
    fs.writeFileSync(textPath, "safe");
    const record = await h.store.intake("account-a", { type: "local", filePath: textPath });
    fs.writeFileSync(path.join(h.root, ...record.relativePath.split("/")), "tampered");
    await assert.rejects(
      h.store.revalidateForSend("account-a", [record.id]),
      (error: unknown) => error instanceof AgentAttachmentError && error.code === "attachment-integrity-failed",
    );
  } finally {
    h.cleanup();
  }
});

test("limits and parsers reject oversized text and damaged DOCX without partial readiness", async () => {
  const h = harness();
  try {
    const tooLong = path.join(h.directory, "too-long.txt");
    fs.writeFileSync(tooLong, "x".repeat(200_001));
    await assert.rejects(
      h.store.intake("account-a", { type: "local", filePath: tooLong }),
      (error: unknown) => error instanceof AgentAttachmentError && error.code === "attachment-character-limit",
    );
    const brokenDocx = path.join(h.directory, "broken.docx");
    fs.writeFileSync(brokenDocx, "not-a-docx");
    await assert.rejects(
      h.store.intake("account-a", { type: "local", filePath: brokenDocx }),
      (error: unknown) => error instanceof AgentAttachmentError && error.code === "attachment-parse-failed",
    );
    await assert.rejects(
      h.store.intakeMany("account-a", Array.from({ length: 11 }, () => ({
        type: "local" as const,
        filePath: brokenDocx,
      }))),
      (error: unknown) => error instanceof AgentAttachmentError && error.code === "attachment-count-limit",
    );
    assert.equal(
      (h.db.prepare("SELECT count(*) AS count FROM agent_attachments").get() as { count: number }).count,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test("images produce dimension metadata and a safe managed thumbnail", async () => {
  const h = harness();
  try {
    const imagePath = path.join(h.directory, "pixel.png");
    fs.writeFileSync(imagePath, await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#cc5533" },
    }).png().toBuffer());
    const record = await h.store.intake("account-a", {
      type: "local",
      filePath: imagePath,
      mediaType: "image/png",
    });
    assert.equal(record.imageWidth, 20);
    assert.equal(record.imageHeight, 10);
    assert.ok(record.thumbnailRelativePath);
    assert.equal(
      fs.existsSync(path.join(h.root, ...record.thumbnailRelativePath.split("/"))),
      true,
    );
    assert.equal(record.characterCount, 0);
  } finally {
    h.cleanup();
  }
});

test("orphan grace, stale part cleanup, and clear-all remove managed files", async () => {
  const h = harness();
  try {
    const textPath = path.join(h.directory, "grace.txt");
    fs.writeFileSync(textPath, "grace");
    const record = await h.store.intake("account-a", { type: "local", filePath: textPath });
    const stalePart = path.join(h.root, "stale.part");
    fs.mkdirSync(h.root, { recursive: true });
    fs.writeFileSync(stalePart, "partial");
    fs.utimesSync(stalePart, new Date("2026-07-31T00:00:00.000Z"), new Date("2026-07-31T00:00:00.000Z"));
    const cleaned = await h.store.cleanup();
    assert.equal(cleaned.parts, 1);

    h.db.prepare("UPDATE agent_attachments SET unreferenced_at = ? WHERE id = ?")
      .run("2026-08-02T10:00:00.000Z", record.id);
    h.setNow("2026-08-08T10:00:00.000Z");
    assert.equal((await h.store.cleanup()).orphans, 0);
    h.setNow("2026-08-09T10:00:01.000Z");
    assert.equal((await h.store.cleanup()).orphans, 1);

    const second = await h.store.intake("account-a", { type: "local", filePath: textPath });
    assert.equal(fs.existsSync(path.join(h.root, ...second.relativePath.split("/"))), true);
    await h.store.clearAll();
    assert.equal(fs.existsSync(h.root), false);
    assert.equal(
      (h.db.prepare("SELECT count(*) AS count FROM agent_attachments").get() as { count: number }).count,
      0,
    );
  } finally {
    h.cleanup();
  }
});
