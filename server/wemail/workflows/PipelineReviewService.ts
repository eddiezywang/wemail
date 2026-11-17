import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExecutionPipelineDraft,
  ReviewCheckpoint,
  ReviewTarget,
  SkillReviewPolicy,
} from "../../../shared/wemail/skillCenter.js";

export type ReviewReply = "accept" | "reject" | "revise" | "ambiguous";

const TARGET_ORDER: ReviewTarget[] = [
  "data",
  "analysis",
  "artifact",
  "delivery",
];

export class PipelineReviewService {
  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  derivePolicies(
    draft: ExecutionPipelineDraft,
  ): Partial<Record<ReviewTarget, SkillReviewPolicy>> {
    return {
      ...(draft.dataSelection &&
      (draft.dataSelection.filters.length > 0 ||
        draft.dataSelection.scope.type !== "current_mail")
        ? { data: "recommended" as const }
        : {}),
      ...(draft.analysis
        ? {
            analysis:
              draft.analysis.modelTasks.length > 0
                ? ("required" as const)
                : ("recommended" as const),
          }
        : {}),
      ...(draft.artifact
        ? { artifact: "required" as const }
        : {}),
      ...(draft.delivery &&
      draft.delivery.destinations.some(
        (destination) =>
          destination.enabled &&
          destination.type !== "conversation" &&
          destination.type !== "message_center",
      )
        ? { delivery: "required" as const }
        : {}),
    };
  }

  synchronizeCheckpoints(
    draft: ExecutionPipelineDraft,
    previews: Partial<
      Record<ReviewTarget, { previewId: string; previewUrl: string }>
    > = {},
  ): ExecutionPipelineDraft {
    const policies = this.derivePolicies(draft);
    const reviews = [...draft.reviews];
    for (const target of TARGET_ORDER) {
      const policy = policies[target];
      if (!policy) continue;
      const contentHash = this.targetHash(draft, target);
      if (!contentHash) continue;
      const current = latest(reviews, target);
      if (current?.contentHash === contentHash) continue;
      if (current && current.status === "accepted") current.status = "stale";
      const preview = previews[target];
      reviews.push({
        id: `review-${randomUUID()}`,
        target,
        policy,
        status: "pending",
        draftRevision: draft.revision,
        targetVersion: targetVersion(draft, target),
        contentHash,
        ...(preview
          ? {
              previewId: preview.previewId,
              previewUrl: preview.previewUrl,
            }
          : {}),
        dependsOn: dependenciesFor(draft, target),
      });
    }
    return { ...draft, reviews };
  }

  respond(
    draft: ExecutionPipelineDraft,
    checkpointId: string,
    message: string,
  ): {
    draft: ExecutionPipelineDraft;
    classification: ReviewReply;
    nextQuestion?: string;
  } {
    const checkpoint = draft.reviews.find((item) => item.id === checkpointId);
    if (!checkpoint || checkpoint.status !== "pending") {
      throw new Error("review-checkpoint-not-current");
    }
    const classification = classifyReviewReply(message);
    if (classification === "ambiguous") {
      return {
        draft,
        classification,
        nextQuestion: "请确认：你是接受当前预览，还是希望继续修改？",
      };
    }
    const reviews = draft.reviews.map((item) => ({ ...item }));
    const selected = reviews.find((item) => item.id === checkpointId)!;
    if (classification === "accept") {
      const currentHash = this.targetHash(draft, selected.target);
      if (
        !currentHash ||
        currentHash !== selected.contentHash ||
        selected.targetVersion !== targetVersion(draft, selected.target)
      ) {
        throw new Error("review-checkpoint-stale");
      }
      selected.status = "accepted";
      selected.feedback = message;
      selected.acceptedAt = this.now();
    } else {
      selected.status = "rejected";
      selected.feedback = message;
    }
    return {
      draft: {
        ...draft,
        revision: draft.revision + 1,
        reviews,
        updatedAt: this.now(),
      },
      classification,
      ...(classification === "revise"
        ? { nextQuestion: "我会按这条意见生成新版本预览。" }
        : {}),
    };
  }

  revise(
    draft: ExecutionPipelineDraft,
    target: ReviewTarget,
    value: unknown,
    preview?: { previewId: string; previewUrl: string },
  ): ExecutionPipelineDraft {
    const next = {
      ...draft,
      revision: draft.revision + 1,
      updatedAt: this.now(),
      ...(target === "data" ? { dataSelection: value as ExecutionPipelineDraft["dataSelection"] } : {}),
      ...(target === "analysis" ? { analysis: value as ExecutionPipelineDraft["analysis"] } : {}),
      ...(target === "artifact" ? { artifact: value as ExecutionPipelineDraft["artifact"] } : {}),
      ...(target === "delivery" ? { delivery: value as ExecutionPipelineDraft["delivery"] } : {}),
      reviews: draft.reviews.map((review) => ({ ...review })),
    };
    const changedTargets = new Set<ReviewTarget>([target]);
    for (const review of next.reviews) {
      if (
        review.status === "accepted" &&
        (changedTargets.has(review.target) ||
          review.dependsOn.some((dependency) => changedTargets.has(dependency)))
      ) {
        review.status = "stale";
        changedTargets.add(review.target);
      }
    }
    return this.synchronizeCheckpoints(
      next,
      preview ? { [target]: preview } : {},
    );
  }

  targetHash(
    draft: ExecutionPipelineDraft,
    target: ReviewTarget,
  ): string | undefined {
    const value =
      target === "data"
        ? draft.dataSelection
        : target === "analysis"
          ? draft.analysis
          : target === "artifact"
            ? draft.artifact
            : draft.delivery;
    return value ? stableHash(value) : undefined;
  }
}

export class PipelinePreviewStore {
  readonly root: string;

  constructor(userDataDir: string) {
    this.root = path.join(path.resolve(userDataDir), "previews", "pipeline");
    fs.mkdirSync(this.root, { recursive: true });
  }

  createArtifactPreview(input: {
    pipelineId: string;
    title: string;
    format: "text" | "image" | "html" | "pdf";
    rows: Array<Record<string, unknown>>;
    xField?: string;
    series?: Array<{ field: string; label: string; color?: string }>;
    textSummary: string;
  }): { previewId: string; previewUrl: string; contentHash: string } {
    const previewId = `pipeline-preview-${randomUUID()}`;
    const html = renderPreviewHtml(input);
    const resource =
      input.format === "image"
        ? {
            body: Buffer.from(renderPreviewSvg(input), "utf8"),
            extension: "svg",
            contentType: "image/svg+xml",
          }
        : input.format === "pdf"
          ? {
              body: renderMinimalPdf(
                `${input.title}\n${input.textSummary}\n${input.rows
                  .slice(0, 20)
                  .map((row) => Object.values(row).join(" | "))
                  .join("\n")}`,
              ),
              extension: "pdf",
              contentType: "application/pdf",
            }
          : {
              body: Buffer.from(html, "utf8"),
              extension: "html",
              contentType: "text/html; charset=utf-8",
            };
    const contentHash = stableHash(resource.body.toString("base64"));
    const directory = path.join(this.root, safe(input.pipelineId));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${previewId}.${resource.extension}`),
      resource.body,
    );
    fs.writeFileSync(
      path.join(directory, `${previewId}.json`),
      JSON.stringify({
        extension: resource.extension,
        contentType: resource.contentType,
      }),
      "utf8",
    );
    return {
      previewId,
      previewUrl: `/api/artifacts/pipeline-preview/${encodeURIComponent(
        input.pipelineId,
      )}/${encodeURIComponent(previewId)}`,
      contentHash,
    };
  }

  read(pipelineId: string, previewId: string): string {
    return this.readResource(pipelineId, previewId).body.toString("utf8");
  }

  readResource(
    pipelineId: string,
    previewId: string,
  ): { body: Buffer; contentType: string } {
    const directory = path.join(this.root, safe(pipelineId));
    const metadataPath = path.join(directory, `${safe(previewId)}.json`);
    if (!isInside(this.root, metadataPath) || !fs.existsSync(metadataPath)) {
      throw new Error("pipeline-preview-not-found");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      extension: string;
      contentType: string;
    };
    const file = path.join(directory, `${safe(previewId)}.${safe(metadata.extension)}`);
    if (!isInside(this.root, file) || !fs.existsSync(file)) {
      throw new Error("pipeline-preview-not-found");
    }
    return { body: fs.readFileSync(file), contentType: metadata.contentType };
  }

  createDataPreview(input: {
    pipelineId: string;
    title: string;
    matches: Array<{
      emailId: string;
      subject?: string;
      sender?: string;
      receivedAt?: string;
      reason?: string;
    }>;
  }) {
    return this.createArtifactPreview({
      pipelineId: input.pipelineId,
      title: input.title,
      format: "text",
      rows: input.matches.slice(0, 10).map((match) => ({
        emailId: match.emailId,
        subject: match.subject?.slice(0, 120),
        sender: match.sender?.slice(0, 120),
        receivedAt: match.receivedAt,
        reason: match.reason?.slice(0, 160),
      })),
      textSummary: `共匹配 ${input.matches.length} 封邮件，预览最多展示 10 封；邮件正文不会写入预览规则。`,
    });
  }

  createAnalysisPreview(input: {
    pipelineId: string;
    title: string;
    rows: Array<Record<string, unknown>>;
    provenance: Array<{ outputPath: string; emailIds: string[] }>;
    summary: string;
  }) {
    return this.createArtifactPreview({
      pipelineId: input.pipelineId,
      title: input.title,
      format: "html",
      rows: input.rows.slice(0, 50),
      textSummary: `${input.summary}；来源样本 ${input.provenance
        .slice(0, 20)
        .flatMap((item) => item.emailIds)
        .length} 条。`,
    });
  }

  createBotMessagePreview(input: {
    pipelineId: string;
    title: string;
    body: string;
    destination: string;
  }) {
    return this.createArtifactPreview({
      pipelineId: input.pipelineId,
      title: "Bot 消息预览",
      format: "text",
      rows: [{
        destination: input.destination,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 2_000),
      }],
      textSummary: "这里只预览将要投递的内容，不会发送消息。",
    });
  }
}

export function classifyReviewReply(message: string): ReviewReply {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return "ambiguous";
  const revise =
    /修改|调整|改成|换成|移到|移动|加上|去掉|颜色|字体|太[大小]|不好|不符合|revise|change|instead/.test(
      normalized,
    );
  if (revise) return "revise";
  if (/^(不行|不要|拒绝|取消|否|no|reject)[。.!！]?$/.test(normalized)) {
    return "reject";
  }
  if (
    /^(可以|符合|满意|同意|接受|确认|就这样|没问题|ok|okay|yes|accept|approved)[了的吧啊呀嘛\s。.!！]*$/.test(
      normalized,
    ) ||
    (/可以|符合|满意|同意|接受|确认|就这样|没问题/.test(normalized) &&
      !/不|但|不过|修改|调整|改/.test(normalized))
  ) {
    return "accept";
  }
  return "ambiguous";
}

function dependenciesFor(
  draft: ExecutionPipelineDraft,
  target: ReviewTarget,
): ReviewTarget[] {
  if (target === "data") return [];
  if (target === "analysis") return draft.dataSelection ? ["data"] : [];
  if (target === "artifact") {
    return [
      ...(draft.dataSelection ? (["data"] as const) : []),
      ...(draft.analysis ? (["analysis"] as const) : []),
    ];
  }
  const contentDependsOnArtifact =
    draft.delivery?.content.includeImage ||
    draft.delivery?.content.includeArtifactLink ||
    draft.delivery?.content.includeFullArtifact;
  return contentDependsOnArtifact && draft.artifact ? ["artifact"] : [];
}

function latest(
  reviews: ReviewCheckpoint[],
  target: ReviewTarget,
): ReviewCheckpoint | undefined {
  return reviews.filter((review) => review.target === target).at(-1);
}

function targetVersion(
  draft: ExecutionPipelineDraft,
  target: ReviewTarget,
): number {
  const value =
    target === "data"
      ? draft.dataSelection
      : target === "analysis"
        ? draft.analysis
        : target === "artifact"
          ? draft.artifact
          : draft.delivery;
  return value && "version" in value && typeof value.version === "number"
    ? value.version
    : draft.revision;
}

function renderPreviewHtml(input: {
  title: string;
  format: string;
  rows: Array<Record<string, unknown>>;
  xField?: string;
  series?: Array<{ field: string; label: string; color?: string }>;
  textSummary: string;
}): string {
  const width = 900;
  const height = 320;
  const xField = input.xField ?? Object.keys(input.rows[0] ?? {})[0] ?? "x";
  const series = input.series ?? [];
  const numeric = series.flatMap((item) =>
    input.rows.map((row) => Number(row[item.field])).filter(Number.isFinite),
  );
  const max = Math.max(1, ...numeric);
  const lineSvg = series.length
    ? `<svg role="img" aria-label="${escapeHtml(input.textSummary)}" viewBox="0 0 ${width} ${height}">${series
        .map((item, seriesIndex) => {
          const points = input.rows
            .map((row, index) => {
              const x =
                40 +
                (index * (width - 80)) /
                  Math.max(1, input.rows.length - 1);
              const y = height - 40 - (Number(row[item.field]) / max) * (height - 80);
              return `${x.toFixed(1)},${Number.isFinite(y) ? y.toFixed(1) : height - 40}`;
            })
            .join(" ");
          return `<polyline fill="none" stroke="${escapeHtml(item.color ?? ["#2563eb", "#dc2626", "#059669"][seriesIndex % 3]!)}" stroke-width="4" points="${points}"><title>${escapeHtml(item.label)}</title></polyline>`;
        })
        .join("")}</svg>`
    : "";
  const table = `<table><thead><tr>${Object.keys(input.rows[0] ?? {})
    .map((key) => `<th>${escapeHtml(key)}</th>`)
    .join("")}</tr></thead><tbody>${input.rows
    .slice(0, 50)
    .map(
      (row) =>
        `<tr>${Object.values(row)
          .map((value) => `<td>${escapeHtml(String(value ?? ""))}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.title)}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#172033;background:#fff}main{max-width:960px;margin:auto}svg{width:100%;background:#f8fafc;border-radius:12px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #dbe3ee;text-align:left}.summary{color:#475569}</style></head><body><main><h1>${escapeHtml(input.title)}</h1><p class="summary">${escapeHtml(input.textSummary)}</p>${lineSvg}${table}<p>预览格式：${escapeHtml(input.format)}；请回到对话中用自然语言确认或提出修改意见。</p></main></body></html>`;
}

function renderPreviewSvg(input: {
  title: string;
  rows: Array<Record<string, unknown>>;
  series?: Array<{ field: string; label: string; color?: string }>;
  textSummary: string;
}): string {
  const width = 1200;
  const height = 630;
  const series = input.series ?? [];
  const values = series.flatMap((item) =>
    input.rows.map((row) => Number(row[item.field])).filter(Number.isFinite),
  );
  const max = Math.max(1, ...values);
  const lines = series
    .map((item, seriesIndex) => {
      const points = input.rows
        .map((row, index) => {
          const x = 80 + (index * 1040) / Math.max(1, input.rows.length - 1);
          const y = 520 - (Number(row[item.field]) / max) * 360;
          return `${x.toFixed(1)},${Number.isFinite(y) ? y.toFixed(1) : 520}`;
        })
        .join(" ");
      return `<polyline fill="none" stroke="${escapeHtml(item.color ?? ["#2563eb", "#dc2626", "#059669"][seriesIndex % 3]!)}" stroke-width="7" points="${points}"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(input.textSummary)}" viewBox="0 0 ${width} ${height}"><rect width="1200" height="630" fill="#ffffff"/><text x="70" y="80" font-family="system-ui" font-size="38" font-weight="700" fill="#172033">${escapeHtml(input.title)}</text><text x="70" y="125" font-family="system-ui" font-size="20" fill="#475569">${escapeHtml(input.textSummary)}</text><rect x="60" y="145" width="1080" height="410" rx="20" fill="#f8fafc"/>${lines}</svg>`;
}

function renderMinimalPdf(text: string): Buffer {
  const lines = text
    .replace(/[^\x20-\x7E\u4E00-\u9FFF]/g, " ")
    .split(/\r?\n/)
    .slice(0, 35);
  const stream = [
    "BT /F1 12 Tf 50 790 Td",
    ...lines.flatMap((line, index) => [
      index === 0 ? "" : "0 -20 Td",
      `(${line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").slice(0, 100)}) Tj`,
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safe(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("preview-id-invalid");
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}
