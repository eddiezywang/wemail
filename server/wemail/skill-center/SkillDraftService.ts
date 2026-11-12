import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionPipelineDraft,
  SkillDraft,
  SkillPackageManifest,
} from "../../../shared/wemail/skillCenter.js";
import type { MailDatabase } from "../database/Database.js";
import { SkillCenterService } from "./SkillCenterService.js";
import { SkillPackageValidator } from "./SkillPackageValidator.js";

export class SkillDraftRepository {
  constructor(private readonly db: MailDatabase) {}

  save(draft: SkillDraft): SkillDraft {
    this.db.prepare(
      `INSERT INTO skill_drafts (
        id, skill_id, version, status, display_name, description,
        skill_markdown, manifest_json, validation_issues_json, content_hash,
        source_session_id, source_pipeline_id, expires_at, created_at, updated_at
      ) VALUES (
        @id, @skillId, @version, @status, @displayName, @description,
        @skillMarkdown, @manifest, @issues, @contentHash, @sourceSessionId,
        @sourcePipelineId, @expiresAt, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        display_name = excluded.display_name,
        description = excluded.description,
        skill_markdown = excluded.skill_markdown,
        manifest_json = excluded.manifest_json,
        validation_issues_json = excluded.validation_issues_json,
        content_hash = excluded.content_hash,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
    ).run({
      id: draft.id,
      skillId: draft.skillId,
      version: draft.version,
      status: draft.status,
      displayName: draft.displayName,
      description: draft.description,
      skillMarkdown: draft.skillMarkdown,
      manifest: JSON.stringify(draft.manifest),
      issues: JSON.stringify(draft.validationIssues),
      contentHash: draft.contentHash,
      sourceSessionId: draft.sourceSessionId ?? null,
      sourcePipelineId: draft.sourcePipelineId ?? null,
      expiresAt: draft.expiresAt,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    });
    return this.get(draft.id)!;
  }

  get(id: string): SkillDraft | null {
    const row = this.db.prepare("SELECT * FROM skill_drafts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      skillId: String(row.skill_id),
      version: String(row.version),
      status: row.status as SkillDraft["status"],
      displayName: String(row.display_name),
      description: String(row.description),
      skillMarkdown: String(row.skill_markdown),
      manifest: JSON.parse(String(row.manifest_json)) as SkillDraft["manifest"],
      validationIssues: JSON.parse(String(row.validation_issues_json)) as string[],
      contentHash: String(row.content_hash),
      ...(row.source_session_id ? { sourceSessionId: String(row.source_session_id) } : {}),
      ...(row.source_pipeline_id ? { sourcePipelineId: String(row.source_pipeline_id) } : {}),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export class SkillDraftService {
  private readonly validator = new SkillPackageValidator();

  constructor(
    private readonly drafts: SkillDraftRepository,
    private readonly center: SkillCenterService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: {
    skillId: string;
    version: string;
    displayName: string;
    description: string;
    skillMarkdown: string;
    manifest?: Partial<Omit<SkillPackageManifest, "contentHash">>;
    sourceSessionId?: string;
    sourcePipelineId?: string;
  }): SkillDraft {
    const now = this.now();
    const markdown = sanitizeSkillText(input.skillMarkdown);
    const manifest: Omit<SkillPackageManifest, "contentHash"> = {
      schemaVersion: 1,
      id: input.skillId,
      version: input.version,
      scope: "personal",
      entry: "SKILL.md",
      displayName: input.displayName,
      description: input.description,
      inputKinds: input.manifest?.inputKinds ?? [],
      outputKinds: input.manifest?.outputKinds ?? [],
      dependencies: input.manifest?.dependencies ?? [],
      toolAllowlist: input.manifest?.toolAllowlist ?? [],
      requestedPermissions: input.manifest?.requestedPermissions ?? [],
      reviewPolicy: input.manifest?.reviewPolicy ?? "recommended",
      ...(input.manifest?.protected !== undefined
        ? { protected: input.manifest.protected }
        : {}),
    };
    const contentHash = hash({ markdown, manifest });
    return this.drafts.save({
      id: `skill-draft-${randomUUID()}`,
      skillId: input.skillId,
      version: input.version,
      status: "draft",
      displayName: sanitizeSkillText(input.displayName),
      description: sanitizeSkillText(input.description),
      skillMarkdown: markdown,
      manifest,
      validationIssues: [],
      contentHash,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.sourcePipelineId ? { sourcePipelineId: input.sourcePipelineId } : {}),
      expiresAt: new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
  }

  createFromPipeline(input: {
    pipeline: ExecutionPipelineDraft;
    skillId: string;
    version: string;
    displayName: string;
    description: string;
  }): SkillDraft {
    const stages = [
      input.pipeline.dataSelection
        ? `1. 按参数化范围选择 ${input.pipeline.dataSelection.source} 数据（${input.pipeline.dataSelection.scope.type}，最多 ${input.pipeline.dataSelection.limits.maxMessages} 条）。`
        : "",
      input.pipeline.analysis
        ? `2. 按已验证的分析配方计算指标（${input.pipeline.analysis.metrics.map((metric) => `${metric.id}:${metric.aggregation}`).join("、") || "无固定指标"}）。`
        : "",
      input.pipeline.artifact
        ? `3. 生成 ${input.pipeline.artifact.format} 产物并评审组件（${input.pipeline.artifact.components.map((component) => component.type).join("、") || "无组件"}）。`
        : "",
      input.pipeline.delivery
        ? `4. 按显式投递策略处理目的地（${input.pipeline.delivery.destinations.filter((destination) => destination.enabled).map((destination) => destination.type).join("、") || "无启用目的地"}）。`
        : "",
    ].filter(Boolean);
    const review = input.pipeline.reviews.length > 0
      ? `已确认评审阶段：${input.pipeline.reviews.filter((review) => review.status === "accepted").map((review) => review.target).join("、") || "无"}。`
      : "执行前仍需根据当前输入重新预览并确认。";
    const safeStages = stages.map((stage) => sanitizeSkillText(stage).replace(/[\r\n]+/g, " "));
    const safeReview = sanitizeSkillText(review).replace(/[\r\n]+/g, " ");
    return this.create({
      skillId: input.skillId,
      version: input.version,
      displayName: input.displayName,
      description: input.description,
      skillMarkdown: `---\nname: ${input.skillId}\ndescription: ${yamlScalar(input.description)}\n---\n\n# ${sanitizeSkillText(input.displayName).replace(/[\r\n]+/g, " ")}\n\n${safeStages.join("\n")}\n\n## 评审与边界\n\n${safeReview}\n不得保存邮件正文、样本值、凭据、临时路径、调用标识或具体接收人。每次运行都必须重新解析当前输入，不能固化本次样本值。`,
      manifest: {
        inputKinds: ["mail-collection"],
        outputKinds: input.pipeline.delivery
          ? ["delivery-plan"]
          : input.pipeline.artifact
            ? ["artifact-recipe"]
            : ["analysis-recipe"],
        dependencies: input.pipeline.skillSnapshots.map((skill) => ({
          skillId: skill.skillId,
          version: skill.version,
        })),
        reviewPolicy: input.pipeline.artifact ? "required" : "recommended",
      },
      sourceSessionId: input.pipeline.sessionId,
      sourcePipelineId: input.pipeline.id,
    });
  }

  validate(id: string): SkillDraft {
    const draft = this.requireCurrent(id);
    const directory = materialize(draft);
    try {
      const result = this.validator.validateDirectory(directory, {
        scope: "personal",
        expectedId: draft.skillId,
        expectedVersion: draft.version,
      });
      return this.drafts.save({
        ...draft,
        status: result.valid ? "awaiting_confirmation" : "draft",
        validationIssues: [...result.issues, ...result.warnings],
        contentHash: result.contentHash ?? draft.contentHash,
        updatedAt: this.now(),
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  install(input: { draftId: string; contentHash: string }) {
    const draft = this.requireCurrent(input.draftId);
    if (
      draft.status !== "awaiting_confirmation" ||
      draft.contentHash !== input.contentHash
    ) {
      throw new Error("skill-draft-install-confirmation-mismatch");
    }
    const directory = materialize(draft);
    try {
      const installed = this.center.installPersonalFromDirectory(directory, "agent");
      const verified = this.center.inspect(installed.skillId, installed.version);
      if (verified.manifest.contentHash !== input.contentHash) {
        throw new Error("skill-draft-post-install-verification-failed");
      }
      this.drafts.save({
        ...draft,
        status: "installed",
        updatedAt: this.now(),
      });
      return verified;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  private requireCurrent(id: string): SkillDraft {
    const draft = this.drafts.get(id);
    if (!draft) throw new Error("skill-draft-not-found");
    if (draft.expiresAt <= this.now()) throw new Error("skill-draft-expired");
    return draft;
  }
}

export function sanitizeSkillText(value: string): string {
  return value
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/\b(?:password|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, "[REDACTED_PATH]")
    .replace(/\/(?:tmp|var\/tmp)\/[^\s)]+/g, "[REDACTED_PATH]")
    .replace(/\b(?:call|run|request|correlation)[-_ ]?id\s*[:=]\s*\S+/gi, "[REDACTED_CALL_ID]")
    .slice(0, 200_000);
}

function yamlScalar(value: string): string {
  return JSON.stringify(
    sanitizeSkillText(value).replace(/[\r\n]+/g, " ").trim(),
  );
}

function materialize(draft: SkillDraft): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-skill-draft-"));
  fs.writeFileSync(path.join(directory, "SKILL.md"), draft.skillMarkdown, "utf8");
  fs.writeFileSync(
    path.join(directory, "wemail.skill.json"),
    `${JSON.stringify({ ...draft.manifest, contentHash: "pending" }, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
