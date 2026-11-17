import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { SkillCenterService } from "./SkillCenterService.js";
import {
  SkillDraftRepository,
  SkillDraftService,
  sanitizeSkillText,
} from "./SkillDraftService.js";
import { SkillPackageRepository } from "./SkillPackageRepository.js";
import { SkillPackageStore } from "./SkillPackageStore.js";

const NOW = "2026-07-29T12:00:00.000Z";

test("conversational Skill drafts remove task data and require exact install hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-skill-draft-"));
  const databasePath = path.join(root, "wemail.sqlite");
  let db = openOrCreateMailDatabase(databasePath);
  try {
    const center = new SkillCenterService(
      new SkillPackageRepository(db, () => NOW),
      new SkillPackageStore({
        userDataDir: path.join(root, "user-data"),
        developmentRoot: root,
        now: () => NOW,
      }),
    );
    const service = new SkillDraftService(
      new SkillDraftRepository(db),
      center,
      () => NOW,
    );
    const draft = service.createFromPipeline({
      pipeline: pipelineFixture(),
      skillId: "personal-monitoring-report",
      version: "1.0.0",
      displayName: "监控日报",
      description: "复用监控日报流程",
    });
    assert.match(
      draft.skillMarkdown,
      /^---\nname: personal-monitoring-report\ndescription: "复用监控日报流程"\n---/,
    );
    assert.doesNotMatch(draft.skillMarkdown, /邮件正文里的客户手机号/);
    assert.doesNotMatch(draft.skillMarkdown, /C:\\Users\\Owner\\Temp/);
    assert.doesNotMatch(draft.skillMarkdown, /call-1234567890/);
    assert.match(draft.skillMarkdown, /不得保存邮件正文、样本值/);
    assert.match(draft.skillMarkdown, /按已验证的分析配方/);
    assert.match(draft.skillMarkdown, /line_chart/);

    const validated = service.validate(draft.id);
    assert.equal(validated.status, "awaiting_confirmation");
    assert.throws(
      () => service.install({ draftId: draft.id, contentHash: "wrong-hash" }),
      /confirmation-mismatch/,
    );
    const installed = service.install({
      draftId: draft.id,
      contentHash: validated.contentHash,
    });
    assert.equal(installed.manifest.contentHash, validated.contentHash);
    assert.equal(center.inspect(draft.skillId, draft.version).active, true);
    assert.equal(
      center.list().find((skill) => skill.id === draft.skillId)?.displayName,
      "监控日报",
    );

    db.close();
    db = openOrCreateMailDatabase(databasePath);
    const restored = new SkillDraftRepository(db).get(draft.id);
    assert.equal(restored?.status, "installed");
    assert.equal(restored?.contentHash, validated.contentHash);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizer redacts credentials, temporary paths, and call identifiers", () => {
  const value = sanitizeSkillText(
    "token=super-secret-value sk-demo_123456789012 C:\\Users\\Owner\\Temp\\mail.txt /tmp/mail-1 call_id=call-123456",
  );
  assert.doesNotMatch(value, /super-secret-value|123456789012|Owner|mail-1|call-123456/);
  assert.match(value, /REDACTED/);
});

function pipelineFixture(): ExecutionPipelineDraft {
  return {
    id: "pipeline-1",
    accountId: "account-1",
    sessionId: "session-1",
    revision: 1,
    mode: "one_shot",
    dataSelection: {
      version: 1,
      source: "mail",
      scope: { type: "calendar_day", timezone: "Asia/Shanghai" },
      filters: [{
        field: "body",
        operator: "contains",
        value: "邮件正文里的客户手机号",
      }],
      limits: { maxMessages: 100 },
    },
    analysis: {
      version: 1,
      inputKinds: ["mail-collection"],
      dimensions: [],
      metrics: [],
      modelTasks: [],
      conclusions: [],
      outputSchema: {},
    },
    artifact: {
      version: 1,
      format: "html",
      title: "C:\\Users\\Owner\\Temp\\report.html",
      components: [{ id: "trend", type: "line_chart" }],
      layout: { structure: "report", sections: ["trend"] },
      theme: { name: "wemail" },
      accessibility: { includeTextSummary: true, chartDescriptions: true },
      emptyState: "暂无数据",
      errorState: "失败",
      outputSchema: {},
    },
    delivery: {
      version: 1,
      destinations: [{ type: "conversation", enabled: true }],
      content: {
        includeSummary: true,
        includeImage: true,
        includeArtifactLink: false,
      },
      fallbackPolicy: { type: "stop" },
    },
    steps: [{
      id: "call-1234567890",
      capabilityId: "output.render",
      input: { body: "邮件正文里的客户手机号" },
      outputKind: "artifact-reference",
      onError: { policy: "stop", retries: 0 },
    }],
    skillSnapshots: [],
    capabilitySnapshots: [],
    reviews: [],
    validation: { status: "valid", issues: [] },
    createdAt: NOW,
    updatedAt: NOW,
  };
}
