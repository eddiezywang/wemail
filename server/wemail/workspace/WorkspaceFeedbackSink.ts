/**
 * Routes user-feedback events into per-account JSONL files inside the
 * workspace.
 *
 * Route C / WP J.4: feedback writers (TagFeedbackRuleRepository,
 * DraftVersionRepository, TodoRepository) accept an optional
 * {@link WorkspaceFeedbackSink} dependency. When the sink is wired,
 * each user accept/reject/edit/delete event appends one JSON line
 * to the appropriate file:
 *
 *   feedback/tag-events.jsonl
 *   feedback/draft-events.jsonl
 *   feedback/todo-events.jsonl
 *
 * The Curator agent (J.5/J.6) consumes these logs to learn user
 * preferences and propose workspace updates. The sink owns the
 * routing rules so repositories don't need to know about file paths.
 *
 * Design rules:
 *   - The sink is intentionally fire-and-forget at the call site:
 *     repositories `await` the append but never let an error block the
 *     primary DB write. (Today the underlying append errors propagate;
 *     the repository wrappers wrap the call in a guard.)
 *   - The append is plain JSONL: one minified JSON object per line,
 *     terminated by `\n`. Each line is independently parseable by the
 *     Curator.
 *   - The clock is injectable for test determinism.
 *   - All file access goes through {@link WorkspaceFileSystem}, so
 *     the sandbox path policy and per-file size limit apply.
 */

import { Buffer } from "node:buffer";
import {
  WorkspaceFileTooLargeError,
  type WorkspaceFileSystem,
} from "./WorkspaceFileSystem.js";

/**
 * Allowed event types. Repository code passes one of these strings;
 * the sink routes to the right file. Future event types can be added
 * here without touching repositories.
 */
export type WorkspaceFeedbackEventType =
  | "tag-reject"
  | "tag-accept"
  | "draft-accept"
  | "draft-delete"
  | "draft-edit"
  | "todo-complete"
  | "todo-delete"
  | "todo-suppress";

export interface WorkspaceFeedbackSink {
  /**
   * Append one event to the appropriate JSONL file. The provided
   * `event` payload is shallow-merged with `{ ts, type }` produced by
   * the sink — callers should not include those fields.
   */
  append(
    eventType: WorkspaceFeedbackEventType,
    event: Record<string, unknown>,
  ): Promise<void>;
}

export interface CreateJsonlFeedbackSinkOptions {
  fs: WorkspaceFileSystem;
  /** ISO-8601 clock for tests. */
  now?: () => string;
}

const FILE_BY_TYPE: Record<WorkspaceFeedbackEventType, string> = {
  "tag-reject": "feedback/tag-events.jsonl",
  "tag-accept": "feedback/tag-events.jsonl",
  "draft-accept": "feedback/draft-events.jsonl",
  "draft-delete": "feedback/draft-events.jsonl",
  "draft-edit": "feedback/draft-events.jsonl",
  "todo-complete": "feedback/todo-events.jsonl",
  "todo-delete": "feedback/todo-events.jsonl",
  "todo-suppress": "feedback/todo-events.jsonl",
};

/**
 * Resolve the JSONL file for a given event type. Exported for tests
 * and the Curator runtime.
 */
export function feedbackFileFor(
  eventType: WorkspaceFeedbackEventType,
): string {
  return FILE_BY_TYPE[eventType];
}

function compactJsonlForAppend(
  existing: string,
  line: string,
  maxBytes: number,
): string {
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > maxBytes) return line;
  const previousLines = existing
    .split("\n")
    .filter((existingLine) => existingLine.trim().length > 0);
  const keptNewestFirst: string[] = [];
  let totalBytes = lineBytes;
  for (let i = previousLines.length - 1; i >= 0; i -= 1) {
    const candidate = `${previousLines[i]}\n`;
    const candidateBytes = Buffer.byteLength(candidate, "utf8");
    if (totalBytes + candidateBytes > maxBytes) break;
    keptNewestFirst.push(candidate);
    totalBytes += candidateBytes;
  }
  return `${keptNewestFirst.reverse().join("")}${line}`;
}

async function appendJsonlLine(
  fs: WorkspaceFileSystem,
  file: string,
  line: string,
): Promise<void> {
  try {
    await fs.appendFile(file, line);
  } catch (err) {
    if (!(err instanceof WorkspaceFileTooLargeError)) throw err;
    const existing = (await fs.readFile(file)) ?? "";
    const compacted = compactJsonlForAppend(existing, line, fs.maxBytes);
    await fs.writeFile(file, compacted);
  }
}

export function createJsonlFeedbackSink(
  options: CreateJsonlFeedbackSinkOptions,
): WorkspaceFeedbackSink {
  const fs = options.fs;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async append(eventType, event) {
      const file = feedbackFileFor(eventType);
      if (!file) {
        // Unknown event types are no-ops; defensive against typos.
        return;
      }
      const record = { ...event, ts: now(), type: eventType };
      const line = JSON.stringify(record) + "\n";
      await appendJsonlLine(fs, file, line);
    },
  };
}
