import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DesignRecipe, MessageArtifactManifest, MessageArtifactSummary } from "../../../shared/wemail/designArtifacts.js";
import type { AutomationOwner } from "../../../shared/wemail/automationCenter.js";
import type { MailDatabase } from "../database/Database.js";

interface ArtifactRow { id: string; version: number; account_id: string; owner_type: "account" | "local_profile"; owner_profile_id: string | null; kind: MessageArtifactManifest["kind"]; title: string; preview: string; manifest_json: string; content_hash: string; preview_only: number; expires_at: string | null }
interface ResourceRow { content_type: string; relative_path: string; sha256: string }

export class MessageArtifactRepository {
  private readonly root: string;
  constructor(private readonly db: MailDatabase, dataDir: string, private readonly now = () => new Date().toISOString()) {
    this.root = path.resolve(dataDir, "message-artifacts");
    mkdirSync(this.root, { recursive: true });
  }

  create(input: { accountId: string; artifactId?: string; version?: number; owner?: AutomationOwner; recipe: DesignRecipe; html: string; preview: string; previewOnly?: boolean; sourceRuleId?: string; sourceRuleVersion?: number; sourceRunId?: string; expiresAt?: string }): MessageArtifactSummary {
    if (Buffer.byteLength(input.html) > 5 * 1024 * 1024) throw new Error("artifact-too-large");
    const id = input.artifactId ?? `artifact-${randomUUID()}`;
    const version = input.version ?? 1;
    const createdAt = this.now();
    const sha256 = createHash("sha256").update(input.html).digest("hex");
    const directory = path.join(this.root, id, String(version));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "index.html"), input.html, { encoding: "utf8", flag: "wx" });
    const manifest: MessageArtifactManifest = { schemaVersion: 1, id, version, kind: input.recipe.kind, title: input.recipe.title, preview: input.preview.slice(0, 500), recipeId: input.recipe.id, recipeVersion: input.recipe.version, designSystem: input.recipe.designSystem, entry: "index.html", resources: [{ name: "index.html", contentType: "text/html; charset=utf-8", size: Buffer.byteLength(input.html), sha256 }], runtimeCapabilities: input.recipe.runtimeCapabilities, sourceRuleId: input.sourceRuleId, sourceRuleVersion: input.sourceRuleVersion, sourceRunId: input.sourceRunId, createdAt, contentHash: sha256 };
    const transaction = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO message_artifacts (id, version, account_id, owner_type, owner_profile_id, kind, title, preview, manifest_json, content_hash, preview_only, source_rule_id, source_rule_version, source_run_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, version, input.accountId, input.owner?.type === "localProfile" ? "local_profile" : "account", input.owner?.type === "localProfile" ? input.owner.profileId : null, input.recipe.kind, input.recipe.title, input.preview.slice(0, 500), JSON.stringify(manifest), sha256, input.previewOnly ? 1 : 0, input.sourceRuleId ?? null, input.sourceRuleVersion ?? null, input.sourceRunId ?? null, createdAt, input.expiresAt ?? null);
      this.db.prepare(`INSERT INTO message_artifact_resources (artifact_id, artifact_version, name, content_type, size, sha256, relative_path) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, version, "index.html", "text/html; charset=utf-8", Buffer.byteLength(input.html), sha256, path.join(id, String(version), "index.html"));
    });
    try { transaction(); } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    return { artifactId: id, version, kind: input.recipe.kind, title: input.recipe.title, preview: input.preview.slice(0, 500), contentHash: sha256 };
  }

  getManifest(id: string, version: number, accountId: string, profileId = "default"): MessageArtifactManifest | null {
    const row = this.db.prepare(
      `SELECT * FROM message_artifacts
       WHERE id = ? AND version = ?
         AND ((owner_type = 'account' AND account_id = ?)
           OR (owner_type = 'local_profile' AND owner_profile_id = ?))
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(id, version, accountId, profileId, this.now()) as ArtifactRow | undefined;
    return row ? JSON.parse(row.manifest_json) as MessageArtifactManifest : null;
  }

  readResource(id: string, version: number, name: string, accountId: string, profileId = "default"): { contentType: string; body: Buffer } | null {
    if (name !== "index.html" || !this.getManifest(id, version, accountId, profileId)) return null;
    const row = this.db.prepare("SELECT content_type, relative_path, sha256 FROM message_artifact_resources WHERE artifact_id = ? AND artifact_version = ? AND name = ?").get(id, version, name) as ResourceRow | undefined;
    if (!row) return null;
    const target = path.resolve(this.root, row.relative_path);
    if (!target.startsWith(`${this.root}${path.sep}`)) return null;
    const body = readFileSync(target);
    if (createHash("sha256").update(body).digest("hex") !== row.sha256) throw new Error("artifact-hash-mismatch");
    return { contentType: row.content_type, body };
  }
}
