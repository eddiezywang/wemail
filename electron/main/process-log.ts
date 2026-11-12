export type ProcessLogLevel = "debug" | "info" | "warn" | "error";

const ANSI_RESET = "\u001b[0m";
const ANSI_LEVEL_COLOR: Record<ProcessLogLevel, string> = {
  debug: "\u001b[90m",
  info: "\u001b[37m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};

/**
 * Renders a consistent, colored process prefix for local desktop diagnostics.
 * The level belongs to the prefix, never to the structured log body.
 */
export function formatProcessLog(
  prefix: string,
  line: string,
  level: ProcessLogLevel,
  options?: { color?: boolean },
): string {
  const normalized = line
    .split(/\r?\n/)
    .map((entry) => removeStructuredLevel(entry))
    .join("\n");
  const trailingNewlines = normalized.match(/(?:\r?\n)+$/)?.[0] ?? "";
  const body = trailingNewlines
    ? normalized.slice(0, -trailingNewlines.length)
    : normalized;
  const formatted = `${prefix} [${level}] ${body}`;
  return options?.color === false
    ? `${formatted}${trailingNewlines}`
    : `${ANSI_LEVEL_COLOR[level]}${formatted}${ANSI_RESET}${trailingNewlines}`;
}

function removeStructuredLevel(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return line;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;
    const { level: _level, ...body } = parsed as Record<string, unknown>;
    return JSON.stringify(body);
  } catch {
    return line;
  }
}
