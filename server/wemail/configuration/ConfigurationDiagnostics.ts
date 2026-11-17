import type { ConfigurationDiagnostic } from "../../../shared/wemail/configuration.js";

const SECRET_FLAG =
  /(--(?:password|passwd|token|api[_-]?key|secret|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;
const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:\\[^\s"']+/g;
const UNIX_TEMP_PATH = /\/(?:tmp|var\/tmp)\/[^\s"']+/g;

export function sanitizeConfigurationDiagnostic(
  value: ConfigurationDiagnostic | undefined,
): ConfigurationDiagnostic | undefined {
  if (!value) return undefined;
  const clean = (input: string | undefined, limit: number) => {
    if (!input) return undefined;
    return input
      .replace(SECRET_FLAG, "$1[REDACTED]")
      .replace(WINDOWS_ABSOLUTE_PATH, "[LOCAL_PATH]")
      .replace(UNIX_TEMP_PATH, "[LOCAL_PATH]")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, limit);
  };
  const diagnostic: ConfigurationDiagnostic = {
    provider: clean(value.provider, 100),
    capability: clean(value.capability, 160),
    tool: clean(value.tool, 100),
    toolCallId: clean(value.toolCallId, 160),
    command: clean(value.command, 1_000),
    errorCode: clean(value.errorCode, 160),
  };
  return Object.fromEntries(
    Object.entries(diagnostic).filter(([, item]) => item !== undefined),
  ) as ConfigurationDiagnostic;
}
