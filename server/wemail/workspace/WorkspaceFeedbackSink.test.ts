import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WorkspaceFileSystem } from "./WorkspaceFileSystem.js";
import {
  createJsonlFeedbackSink,
  feedbackFileFor,
} from "./WorkspaceFeedbackSink.js";
import { createWorkspacePathPolicy } from "./WorkspacePathPolicy.js";

function freshSink(opts: { now?: () => string; maxFileBytes?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-wfs-sink-"));
  const policy = createWorkspacePathPolicy({ root });
  const fsys = new WorkspaceFileSystem({
    policy,
    maxFileBytes: opts.maxFileBytes,
  });
  const sink = createJsonlFeedbackSink({ fs: fsys, now: opts.now });
  return { sink, fs: fsys, root };
}

test("feedbackFileFor: routes tag events to feedback/tag-events.jsonl", () => {
  assert.equal(feedbackFileFor("tag-reject"), "feedback/tag-events.jsonl");
  assert.equal(feedbackFileFor("tag-accept"), "feedback/tag-events.jsonl");
});

test("feedbackFileFor: routes draft events to feedback/draft-events.jsonl", () => {
  assert.equal(feedbackFileFor("draft-accept"), "feedback/draft-events.jsonl");
  assert.equal(feedbackFileFor("draft-delete"), "feedback/draft-events.jsonl");
  assert.equal(feedbackFileFor("draft-edit"), "feedback/draft-events.jsonl");
});

test("feedbackFileFor: routes todo events to feedback/todo-events.jsonl", () => {
  assert.equal(feedbackFileFor("todo-complete"), "feedback/todo-events.jsonl");
  assert.equal(feedbackFileFor("todo-delete"), "feedback/todo-events.jsonl");
  assert.equal(feedbackFileFor("todo-suppress"), "feedback/todo-events.jsonl");
});

test("WorkspaceFeedbackSink: appends one JSON line with ts + type + payload", async () => {
  let count = 0;
  const fixedNow = () => {
    count += 1;
    return `2026-04-27T00:00:0${count}Z`;
  };
  const { sink, fs: w } = freshSink({ now: fixedNow });
  await sink.append("tag-reject", { tagName: "通知", emailId: "e1" });
  const content = await w.readFile("feedback/tag-events.jsonl");
  assert.ok(content);
  const lines = content!.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.ts, "2026-04-27T00:00:01Z");
  assert.equal(parsed.type, "tag-reject");
  assert.equal(parsed.tagName, "通知");
  assert.equal(parsed.emailId, "e1");
});

test("WorkspaceFeedbackSink: separate event types route to separate files", async () => {
  const { sink, fs: w } = freshSink();
  await sink.append("tag-reject", { tagName: "通知" });
  await sink.append("draft-accept", { emailId: "e1", draftLength: 200 });
  await sink.append("todo-complete", { todoId: "t1" });

  const tagContent = await w.readFile("feedback/tag-events.jsonl");
  const draftContent = await w.readFile("feedback/draft-events.jsonl");
  const todoContent = await w.readFile("feedback/todo-events.jsonl");

  assert.ok(tagContent);
  assert.ok(draftContent);
  assert.ok(todoContent);

  assert.equal(JSON.parse(tagContent!.trim()).type, "tag-reject");
  assert.equal(JSON.parse(draftContent!.trim()).type, "draft-accept");
  assert.equal(JSON.parse(todoContent!.trim()).type, "todo-complete");
});

test("WorkspaceFeedbackSink: appends multiple lines as JSONL", async () => {
  const { sink, fs: w } = freshSink();
  await sink.append("tag-reject", { tagName: "a" });
  await sink.append("tag-accept", { tagName: "b" });
  await sink.append("tag-reject", { tagName: "c" });
  const content = await w.readFile("feedback/tag-events.jsonl");
  const lines = content!.trim().split("\n");
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.ok(parsed.ts);
    assert.ok(parsed.type);
    assert.ok(parsed.tagName);
  }
});

test("WorkspaceFeedbackSink: payload fields cannot override ts/type", async () => {
  const { sink, fs: w } = freshSink({
    now: () => "2026-04-27T00:00:00Z",
  });
  await sink.append("tag-reject", {
    ts: "1970-01-01T00:00:00Z",
    type: "draft-accept",
    tagName: "x",
  });
  const content = await w.readFile("feedback/tag-events.jsonl");
  const parsed = JSON.parse(content!.trim());
  assert.equal(parsed.ts, "2026-04-27T00:00:00Z");
  assert.equal(parsed.type, "tag-reject");
  assert.equal(parsed.tagName, "x");
});

test("WorkspaceFeedbackSink: compacts old JSONL records when the log hits maxFileBytes", async () => {
  const { sink, fs: w } = freshSink({
    maxFileBytes: 220,
    now: () => "2026-04-27T00:00:00Z",
  });

  for (let i = 0; i < 6; i += 1) {
    await sink.append("tag-reject", {
      tagName: `tag-${i}`,
      reason: "x".repeat(60),
    });
  }

  const content = await w.readFile("feedback/tag-events.jsonl");
  assert.ok(content);
  assert.ok(Buffer.byteLength(content!, "utf8") <= 220);
  const lines = content!.trim().split("\n");
  assert.ok(lines.length >= 1);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.at(-1).tagName, "tag-5");
  assert.equal(parsed.at(-1).type, "tag-reject");
});
