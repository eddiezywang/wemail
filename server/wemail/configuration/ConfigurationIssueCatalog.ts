import { randomUUID } from "node:crypto";
import type {
  ConfigurationIssue,
  ConfigurationIssueCategory,
  ConfigurationIssueResponsibility,
  ConfigurationIssueSeverity,
  ConfigurationPhase,
  ConfigurationPrivacyClass,
  ConfigurationRecoveryType,
  ConfigurationRetryability,
} from "../../../shared/wemail/configuration.js";

export interface ConfigurationIssueDefinition {
  code: string;
  category: ConfigurationIssueCategory;
  message: string;
  severity: ConfigurationIssueSeverity;
  responsibility: ConfigurationIssueResponsibility;
  retryability: ConfigurationRetryability;
  privacyClass: ConfigurationPrivacyClass;
  recoveryTypes: ConfigurationRecoveryType[];
  notify: boolean;
}

const DEFINITIONS: ConfigurationIssueDefinition[] = [
  definition("missing_information", "missing_information", "需要补充配置所需的信息。", "blocking", "user_action", "safe_after_recovery", ["provide_input", "cancel"]),
  definition("dependency_unavailable", "dependency_unavailable", "当前环境缺少这项配置依赖。", "blocking", "user_action", "safe_after_recovery", ["install_dependency", "open_settings", "cancel"]),
  definition("wecli_binary_missing", "dependency_unavailable", "未检测到 WeCLI，因此依赖它的配置步骤尚未执行。", "blocking", "user_action", "safe_after_recovery", ["install_dependency", "open_settings", "cancel"]),
  definition("provider_unavailable", "provider_unavailable", "所需服务当前不可用。", "blocking", "system_retry", "safe_after_recovery", ["retry_phase", "open_settings", "cancel"]),
  definition("authentication_required", "authentication_required", "需要先完成登录或重新认证。", "blocking", "user_action", "safe_after_recovery", ["authenticate", "open_settings", "cancel"]),
  definition("permission_denied", "permission_denied", "当前账户没有完成这项配置所需的权限。", "blocking", "administrator", "safe_after_recovery", ["request_permission", "open_settings", "cancel"]),
  definition("resource_unavailable", "resource_unavailable", "配置引用的资源当前不可用。", "blocking", "configuration_change", "safe_after_recovery", ["select_resource", "retry_phase", "cancel"]),
  definition("capability_unsupported", "capability_unsupported", "当前版本不支持请求的配置能力。", "blocking", "unsupported", "not_retryable", ["open_settings", "cancel"]),
  definition("validation_failed", "validation_failed", "配置未通过校验。", "blocking", "configuration_change", "safe_after_recovery", ["provide_input", "restart_configuration", "cancel"], false),
  definition("configuration_conflict", "configuration_conflict", "配置已在其他位置发生变化，需要重新读取。", "blocking", "configuration_change", "safe_after_recovery", ["restart_configuration", "cancel"]),
  definition("stale_preview", "stale_preview", "配置预览已过期，需要重新生成。", "blocking", "configuration_change", "safe_after_recovery", ["regenerate_preview", "cancel"], false),
  definition("capability_drift", "capability_drift", "配置依赖的能力已经变化，需要重新预览确认。", "blocking", "configuration_change", "safe_after_recovery", ["regenerate_preview", "cancel"]),
  definition("confirmation_required", "confirmation_required", "这项配置需要你的明确确认。", "blocking", "user_action", "safe_after_recovery", ["cancel"], false),
  definition("policy_blocked", "policy_blocked", "这项配置受到安全策略限制。", "blocking", "administrator", "not_retryable", ["open_settings", "cancel"]),
  definition("transient_service_failure", "transient_service_failure", "服务暂时不可用，稍后可以安全重试。", "warning", "system_retry", "safe_immediate", ["retry_phase", "cancel"], false),
  definition("execution_failed", "execution_failed", "配置步骤执行失败。", "fatal", "system_retry", "unknown", ["restart_configuration", "cancel"]),
  definition("execution_outcome_unknown", "execution_outcome_unknown", "外部操作结果暂时无法确认，请先核查，系统不会自动重试。", "fatal", "administrator", "unknown", ["reconcile_outcome", "cancel"]),
  definition("provider_unclassified_failure", "execution_failed", "配置服务发生未分类错误。", "fatal", "system_retry", "unknown", ["restart_configuration", "cancel"]),
];

export class ConfigurationIssueCatalog {
  private readonly definitions = new Map(
    DEFINITIONS.map((item) => [item.code, item]),
  );

  register(definition: ConfigurationIssueDefinition): void {
    if (this.definitions.has(definition.code)) {
      throw new Error(`configuration-issue-already-registered:${definition.code}`);
    }
    this.definitions.set(definition.code, definition);
  }

  get(code: string): ConfigurationIssueDefinition | undefined {
    return this.definitions.get(code);
  }

  require(code: string): ConfigurationIssueDefinition {
    return (
      this.get(code) ??
      this.definitions.get("provider_unclassified_failure")!
    );
  }

  create(input: {
    code: string;
    phase: ConfigurationPhase;
    now?: string;
    userMessage?: string;
    affectedScope?: string[];
    unaffectedScope?: string[];
    diagnostic?: ConfigurationIssue["diagnostic"];
  }): ConfigurationIssue {
    const definition = this.require(input.code);
    return {
      id: `configuration-issue-${randomUUID()}`,
      category: definition.category,
      code: definition.code,
      phase: input.phase,
      severity: definition.severity,
      userMessage: (input.userMessage?.trim() || definition.message).slice(
        0,
        500,
      ),
      responsibility: definition.responsibility,
      retryability: definition.retryability,
      privacyClass: definition.privacyClass,
      affectedScope: (input.affectedScope ?? []).slice(0, 20),
      ...(input.unaffectedScope
        ? { unaffectedScope: input.unaffectedScope.slice(0, 20) }
        : {}),
      ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
      createdAt: input.now ?? new Date().toISOString(),
    };
  }
}

function definition(
  code: string,
  category: ConfigurationIssueCategory,
  message: string,
  severity: ConfigurationIssueSeverity,
  responsibility: ConfigurationIssueResponsibility,
  retryability: ConfigurationRetryability,
  recoveryTypes: ConfigurationRecoveryType[],
  notify = true,
): ConfigurationIssueDefinition {
  return {
    code,
    category,
    message,
    severity,
    responsibility,
    retryability,
    privacyClass: "diagnostic",
    recoveryTypes,
    notify,
  };
}
