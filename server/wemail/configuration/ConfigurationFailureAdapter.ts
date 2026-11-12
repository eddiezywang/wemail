import type {
  ConfigurationEffectState,
  ConfigurationOperationResult,
  ConfigurationPhase,
} from "../../../shared/wemail/configuration.js";
import { ConfigurationIssueCatalog } from "./ConfigurationIssueCatalog.js";
import { sanitizeConfigurationDiagnostic } from "./ConfigurationDiagnostics.js";

export interface ConfigurationFailureMetrics {
  increment(name: "configuration.issue.unclassified", fields?: Record<string, string>): void;
}

export class ConfigurationFailureAdapter {
  constructor(
    private readonly catalog = new ConfigurationIssueCatalog(),
    private readonly metrics?: ConfigurationFailureMetrics,
  ) {}

  unavailable<T>(input: {
    code: string;
    phase: ConfigurationPhase;
    message?: string;
    provider?: string;
    capability?: string;
    partialValue?: T;
    affectedScope?: string[];
    unaffectedScope?: string[];
  }): Extract<ConfigurationOperationResult<T>, { status: "unavailable" }> {
    const known = this.catalog.get(input.code);
    if (!known) {
      this.metrics?.increment("configuration.issue.unclassified", {
        source: "unavailable",
      });
    }
    return {
      status: "unavailable",
      effectState: "none",
      issue: this.catalog.create({
        code: input.code,
        phase: input.phase,
        userMessage: known ? input.message : undefined,
        affectedScope: input.affectedScope,
        unaffectedScope: input.unaffectedScope,
        diagnostic: sanitizeConfigurationDiagnostic({
          provider: input.provider,
          capability: input.capability,
          errorCode: input.code,
        }),
      }),
      ...(input.partialValue === undefined
        ? {}
        : { partialValue: input.partialValue }),
    };
  }

  failed(input: {
    error: unknown;
    phase: ConfigurationPhase;
    effectState?: ConfigurationEffectState;
    provider?: string;
    capability?: string;
    tool?: string;
    toolCallId?: string;
    command?: string;
  }): Extract<ConfigurationOperationResult<never>, { status: "failed" }> {
    const normalized = normalizeError(input.error);
    const mappedCode = knownCode(normalized.code, normalized.message);
    if (mappedCode === "provider_unclassified_failure") {
      this.metrics?.increment("configuration.issue.unclassified", {
        source: input.provider ?? input.tool ?? "unknown",
      });
    }
    const effectState =
      mappedCode === "execution_outcome_unknown"
        ? "unknown"
        : input.effectState ?? "none";
    return {
      status: "failed",
      effectState,
      issue: this.catalog.create({
        code: mappedCode,
        phase: input.phase,
        diagnostic: sanitizeConfigurationDiagnostic({
          provider: input.provider,
          capability: input.capability,
          tool: input.tool,
          toolCallId: input.toolCallId,
          command: input.command,
          errorCode: normalized.code,
        }),
      }),
    };
  }
}

function normalizeError(error: unknown): { code?: string; message: string } {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code =
      typeof record.code === "string"
        ? record.code
        : typeof record.name === "string"
          ? record.name
          : undefined;
    const message =
      typeof record.userMessage === "string"
        ? record.userMessage
        : typeof record.error === "string"
          ? record.error
          : typeof record.message === "string"
            ? record.message
            : String(error);
    return { code, message };
  }
  return { message: String(error) };
}

function knownCode(code: string | undefined, message: string): string {
  const normalized = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === "wecli_binary_missing" ||
    /weclibinarymissingerror|wecli binary not found|wecli.*enoent/.test(
      normalized,
    )
  ) {
    return "wecli_binary_missing";
  }
  if (/auth|not logged|未登录|认证/.test(normalized)) {
    return "authentication_required";
  }
  if (/permission|forbidden|权限|拒绝访问/.test(normalized)) {
    return "permission_denied";
  }
  if (/preview.*expired|preview-not-found|预览.*过期/.test(normalized)) {
    return "stale_preview";
  }
  if (/capabilit.*(?:changed|drift)|能力.*变化/.test(normalized)) {
    return "capability_drift";
  }
  if (/connected-bot-unavailable|没有已连接.*bot/.test(normalized)) {
    return "resource_unavailable";
  }
  if (/capabilit.*unavailable|capability.*unsupported|能力.*不支持/.test(normalized)) {
    return "capability_unsupported";
  }
  if (/conflict|revision.*mismatch|版本冲突/.test(normalized)) {
    return "configuration_conflict";
  }
  if (/timeout|econn|network|temporar|网络|暂时不可用/.test(normalized)) {
    return "transient_service_failure";
  }
  if (/outcome.*unknown|result.*unknown|结果.*无法确认/.test(normalized)) {
    return "execution_outcome_unknown";
  }
  return "provider_unclassified_failure";
}
