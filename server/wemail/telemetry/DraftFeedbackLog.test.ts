import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  DRAFT_EXCERPT_MAX_CHARS,
  DRAFT_FEEDBACK_EVENTS,
  DraftFeedbackLog,
  type DraftFeedbackEvent,
} from "./DraftFeedbackLog.js";

interface Capture {
  log: DraftFeedbackLog;
  buffer: { path: string; data: string };
}

function makeLog(baseDir = "/fake/base"): Capture {
  const buffer = { path: "", data: "" };
  const log = new DraftFeedbackLog({
    baseDir,
    now: () => "2026-04-24T10:00:00.000Z",
    writer: async (filePath: string, data: string) => {
      buffer.path = filePath;
      buffer.data += data;
    },
  });
  return { log, buffer };
}

test("DraftFeedbackLog file path lives under <baseDir>/logs/draft-feedback.md", () => {
  const { log } = makeLog("/home/user/app");
  assert.equal(
    log.filePath,
    path.join("/home/user/app", "logs", "draft-feedback.md"),
  );
});

test("DraftFeedbackLog produces a section with the expected heading for every event", async () => {
  for (const event of DRAFT_FEEDBACK_EVENTS) {
    const { log, buffer } = makeLog();
    await log.logDraftEvent({ emailId: "acct-1:INBOX:1:5", event });
    assert.ok(
      buffer.data.includes(
        `## [2026-04-24T10:00:00.000Z] acct-1:INBOX:1:5 — ${event}`,
      ),
      `missing heading for event ${event}`,
    );
    assert.ok(buffer.data.includes(`- event: ${event}`));
    assert.ok(buffer.data.trimEnd().endsWith("---"));
  }
});

test("DraftFeedbackLog truncates draftExcerpt to 500 chars and wraps in a code fence", async () => {
  const { log, buffer } = makeLog();
  const big = "x".repeat(DRAFT_EXCERPT_MAX_CHARS + 200);
  await log.logDraftEvent({
    emailId: "id-1",
    event: "generated",
    draftExcerpt: big,
  });
  // Body is capped; the code fence keeps the marker reader-friendly.
  const fenceStart = buffer.data.indexOf("```");
  const fenceEnd = buffer.data.lastIndexOf("```");
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart);
  const inside = buffer.data.slice(fenceStart + 3, fenceEnd);
  // DRAFT_EXCERPT_MAX_CHARS of "x" plus the "…" ellipsis.
  assert.ok(inside.includes("x".repeat(DRAFT_EXCERPT_MAX_CHARS)));
  assert.ok(inside.includes("…"));
  assert.ok(!inside.includes("x".repeat(DRAFT_EXCERPT_MAX_CHARS + 1)));
});

test("DraftFeedbackLog appends rather than overwriting", async () => {
  const { log, buffer } = makeLog();
  await log.logDraftEvent({ emailId: "id-a", event: "generated" });
  await log.logDraftEvent({ emailId: "id-b", event: "accepted" });
  await log.logDraftEvent({ emailId: "id-c", event: "deleted" });
  // All three headings present in order.
  const idxA = buffer.data.indexOf("id-a — generated");
  const idxB = buffer.data.indexOf("id-b — accepted");
  const idxC = buffer.data.indexOf("id-c — deleted");
  assert.ok(idxA >= 0 && idxB > idxA && idxC > idxB);
  // Separators between entries (\n---\n).
  const separatorCount = (buffer.data.match(/\n---\n/g) ?? []).length;
  assert.equal(separatorCount, 3);
});

test("DraftFeedbackLog serializes concurrent writes (no interleaving)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const captured: string[] = [];
  const log = new DraftFeedbackLog({
    baseDir: "/fake",
    now: () => "2026-04-24T10:00:00.000Z",
    writer: async (_path, data) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      captured.push(data);
      inFlight -= 1;
    },
  });
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      log.logDraftEvent({
        emailId: `id-${i}`,
        event: "generated",
      }),
    ),
  );
  assert.equal(maxInFlight, 1, "writes must be strictly serialized");
  assert.equal(captured.length, 5);
});

test("DraftFeedbackLog omits draft excerpt when not supplied", async () => {
  const { log, buffer } = makeLog();
  await log.logDraftEvent({ emailId: "id-x", event: "generated" });
  assert.ok(!buffer.data.includes("Draft excerpt"));
  assert.ok(!buffer.data.includes("```"));
});

test("DraftFeedbackLog cross-platform path (uses path.join, not hard-coded separators)", () => {
  const { log } = makeLog("/base");
  // Whatever separator path.join emits on the host OS is fine; the
  // important bit is we did not hard-code `/` or `\`.
  assert.ok(log.filePath.includes("logs"));
  assert.ok(log.filePath.endsWith("draft-feedback.md"));
});

test("DRAFT_FEEDBACK_EVENTS contains exactly the four lifecycle events", () => {
  const sorted: DraftFeedbackEvent[] = [...DRAFT_FEEDBACK_EVENTS];
  assert.deepEqual(
    sorted,
    ["generated", "accepted", "edited_and_sent", "deleted"],
  );
});
