import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import {
  ExecutionPipelineDraftRepository,
  PipelineDraftConflictError,
} from "./ExecutionPipelineDraftRepository.js";

function insertAccount(db: ReturnType<typeof openOrCreateMailDatabase>) {
  insertCanonicalTestAccount(db, { id: "acct-pipeline", email: "pipeline@example.com" });
}

function draft(): ExecutionPipelineDraft {
  return {
    id: "pipeline-1",
    accountId: "acct-pipeline",
    sessionId: "session-1",
    revision: 1,
    mode: "automation",
    trigger: {
      event: "schedule",
      timing: {
        type: "daily",
        localTime: "21:00",
        timezone: "Asia/Shanghai",
      },
    },
    dataSelection: {
      version: 1,
      source: "mail",
      scope: { type: "calendar_day", timezone: "Asia/Shanghai" },
      filters: [],
      limits: { maxMessages: 500 },
    },
    artifact: {
      version: 2,
      format: "html",
      title: "电销平台日报",
      components: [{ id: "trend", type: "line_chart" }],
      layout: { structure: "overview-to-detail", sections: ["trend"] },
      theme: { name: "monitoring" },
      accessibility: {
        includeTextSummary: true,
        chartDescriptions: true,
      },
      emptyState: "暂无数据",
      errorState: "生成失败",
      outputSchema: { type: "artifact-reference" },
    },
    steps: [
      {
        id: "render",
        capabilityId: "report.renderHtml",
        input: {},
        outputKind: "artifact-reference",
        onError: { policy: "stop", retries: 0 },
      },
    ],
    skillSnapshots: [
      {
        skillId: "builtin:wemail/artifact-review",
        version: "1.0.0",
        contentHash: "skill-hash",
        scope: "builtin",
      },
    ],
    capabilitySnapshots: [],
    reviews: [
      {
        id: "review-1",
        target: "artifact",
        policy: "required",
        status: "accepted",
        draftRevision: 1,
        targetVersion: 2,
        contentHash: "artifact-hash",
        previewId: "preview-1",
        previewUrl: "/artifacts/preview-1",
        dependsOn: ["analysis"],
        acceptedAt: "2026-07-29T01:00:00.000Z",
      },
    ],
    validation: {
      status: "valid",
      issues: [],
      validatedAt: "2026-07-29T01:00:00.000Z",
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T01:00:00.000Z",
  };
}

test("pipeline drafts and accepted review state reload after database restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-pipeline-"));
  const file = path.join(dir, "wemail.sqlite");
  const first = openOrCreateMailDatabase(file);
  insertAccount(first);
  const created = new ExecutionPipelineDraftRepository(first).create(draft());
  assert.equal(created.reviews[0]?.status, "accepted");
  first.close();

  const reopened = openOrCreateMailDatabase(file);
  try {
    const restored = new ExecutionPipelineDraftRepository(reopened).get(
      "pipeline-1",
      "acct-pipeline",
    );
    assert.deepEqual(restored, created);
    assert.equal(restored?.artifact?.components[0]?.type, "line_chart");
  } finally {
    reopened.close();
  }
});

test("pipeline draft repository rejects stale replacement", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    insertAccount(db);
    const repository = new ExecutionPipelineDraftRepository(db);
    const created = repository.create(draft());
    const updated = {
      ...created,
      revision: 2,
      updatedAt: "2026-07-29T02:00:00.000Z",
    };
    repository.replace(updated, 1);

    assert.throws(
      () =>
        repository.replace(
          {
            ...created,
            revision: 2,
            updatedAt: "2026-07-29T03:00:00.000Z",
          },
          1,
        ),
      PipelineDraftConflictError,
    );
  } finally {
    db.close();
  }
});
