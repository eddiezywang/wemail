/**
 * Append-only Markdown feedback log for reply-draft lifecycle events
 * (Handoff §5.G, §5.H).
 *
 * Purpose:
 *   - Human-readable record of how drafts flow through the UI.
 *   - Phase-one: single growing file under `<baseDir>/logs/draft-feedback.md`.
 *     Rotation is a future change (§5.H notes monthly filenames).
 *
 * Safety rails:
 *   - NEVER contains the incoming mail body. The caller passes only
 *     `event`, a stable `emailId`, an optional `draftExcerpt` (the
 *     user-scoped OUTBOUND draft, capped to 500 chars), and optional
 *     short `notes`.
 *   - Writes are serialized through an async mutex to avoid interleaved
 *     appends when multiple requests land simultaneously.
 *   - A `writer` seam is exposed so tests can intercept disk IO.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type DraftFeedbackEvent =
  | "generated"
  | "accepted"
  | "edited_and_sent"
  | "deleted";

export const DRAFT_FEEDBACK_EVENTS: readonly DraftFeedbackEvent[] =
  Object.freeze([
    "generated",
    "accepted",
    "edited_and_sent",
    "deleted",
  ]) as readonly DraftFeedbackEvent[];

export const DRAFT_EXCERPT_MAX_CHARS = 500;

export interface DraftFeedbackEntry {
  emailId: string;
  event: DraftFeedbackEvent;
  at?: string;
  /**
   * OPTIONAL outbound draft excerpt, capped to 500 chars. This is
   * user-owned content (the draft the assistant produced), NOT the
   * incoming mail body.
   */
  draftExcerpt?: string;
  /** OPTIONAL short free-text note (e.g. `"user accepted via renderer"`). */
  notes?: string;
}

export type DraftFeedbackWriter = (
  filePath: string,
  data: string,
) => Promise<void>;

export interface DraftFeedbackLogDeps {
  /** Absolute path to the `logs/` parent directory. */
  baseDir: string;
  /** Injectable clock; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /**
   * Injectable writer. Default performs `fs.mkdir -p` + `fs.appendFile`
   * so production just works; tests can substitute an in-memory buffer.
   */
  writer?: DraftFeedbackWriter;
  /** Log file basename. Defaults to `draft-feedback.md`. */
  filename?: string;
}

/** Default writer — append to disk, creating parent dirs as needed. */
async function defaultWriter(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, data, "utf8");
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}

/**
 * Serializes async work via a shared tail-promise so concurrent
 * `logDraftEvent` calls produce a well-formed file.
 */
export class DraftFeedbackLog {
  readonly filePath: string;
  private readonly writer: DraftFeedbackWriter;
  private readonly now: () => string;
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: DraftFeedbackLogDeps) {
    const filename = deps.filename ?? "draft-feedback.md";
    // path.join is cross-platform; we resolve against the provided baseDir.
    this.filePath = path.join(deps.baseDir, "logs", filename);
    this.writer = deps.writer ?? defaultWriter;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async logDraftEvent(entry: DraftFeedbackEntry): Promise<void> {
    const next = this.tail.then(() => this.writeEntry(entry));
    // Swallow errors on the shared chain so one failure doesn't poison
    // subsequent writes; re-throw to the caller of this specific call.
    this.tail = next.catch(() => {});
    await next;
  }

  private async writeEntry(entry: DraftFeedbackEntry): Promise<void> {
    const at = entry.at ?? this.now();
    const lines: string[] = [];
    lines.push(`## [${at}] ${entry.emailId} — ${entry.event}`);
    lines.push("");
    lines.push(`- event: ${entry.event}`);
    lines.push(`- emailId: ${entry.emailId}`);
    lines.push(`- at: ${at}`);

    if (entry.draftExcerpt && entry.draftExcerpt.length > 0) {
      const excerpt = truncate(entry.draftExcerpt, DRAFT_EXCERPT_MAX_CHARS);
      lines.push("");
      lines.push("### Draft excerpt");
      lines.push("");
      lines.push("```");
      lines.push(excerpt);
      lines.push("```");
    }

    if (entry.notes && entry.notes.length > 0) {
      lines.push("");
      lines.push(`Notes: ${entry.notes}`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");

    await this.writer(this.filePath, lines.join("\n"));
  }
}
