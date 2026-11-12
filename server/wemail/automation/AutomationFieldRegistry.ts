import type { AutomationFieldDefinition } from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";

export interface SemanticFieldDependency {
  fieldPath: string;
  emailId: string;
}

export type TemporalResolution =
  | {
      status: "ready";
      valueType: "date" | "datetime";
      values: string[];
    }
  | {
      status: "pending";
      dependencies: SemanticFieldDependency[];
    }
  | {
      status: "unavailable";
      reasons: string[];
    };

export interface AutomationFieldResolveContext {
  message: MailMessage;
  scope?: "mail" | "matchingAttachments";
}

export interface AutomationFieldProvider {
  definition: AutomationFieldDefinition;
  resolve(context: AutomationFieldResolveContext): Promise<TemporalResolution>;
  ensure?(context: AutomationFieldResolveContext): Promise<void>;
}

export class AutomationFieldRegistry {
  private readonly providers = new Map<string, AutomationFieldProvider>();

  static withNativeFields(): AutomationFieldRegistry {
    const registry = new AutomationFieldRegistry();
    registry.register({
      definition: {
        path: "mail.receivedAt",
        label: "收到邮件的时间",
        description: "邮件进入邮箱的精确时间",
        valueType: "datetime",
        cardinality: "one",
        scope: "mail",
        availability: "immediate",
      },
      async resolve(context) {
        return {
          status: "ready",
          valueType: "datetime",
          values: [context.message.receivedAt],
        };
      },
    });
    return registry;
  }

  register(provider: AutomationFieldProvider): void {
    if (this.providers.has(provider.definition.path)) {
      throw new Error(`duplicate-automation-field:${provider.definition.path}`);
    }
    this.providers.set(provider.definition.path, provider);
  }

  async resolve(
    fieldPath: string,
    context: AutomationFieldResolveContext,
  ): Promise<TemporalResolution> {
    const provider = this.providers.get(fieldPath);
    if (!provider) {
      return {
        status: "unavailable",
        reasons: [`unknown-automation-field:${fieldPath}`],
      };
    }
    if (context.scope && !isScopeCompatible(provider.definition.scope, context.scope)) {
      return {
        status: "unavailable",
        reasons: [`automation-field-scope-mismatch:${fieldPath}`],
      };
    }
    const resolution = await provider.resolve(context);
    if (resolution.status !== "ready") return resolution;
    if (resolution.valueType !== provider.definition.valueType) {
      return {
        status: "unavailable",
        reasons: [`automation-field-value-type-mismatch:${fieldPath}`],
      };
    }
    if (provider.definition.cardinality === "one" && resolution.values.length !== 1) {
      return {
        status: "unavailable",
        reasons: [`automation-field-cardinality-mismatch:${fieldPath}`],
      };
    }
    return resolution;
  }

  async ensure(
    dependencies: SemanticFieldDependency[],
    context: AutomationFieldResolveContext,
  ): Promise<void> {
    const fieldPaths = new Set(dependencies.map((dependency) => dependency.fieldPath));
    await Promise.all([...fieldPaths].map(async (fieldPath) => {
      const provider = this.providers.get(fieldPath);
      if (provider?.ensure) await provider.ensure(context);
    }));
  }
}

function isScopeCompatible(
  fieldScope: AutomationFieldDefinition["scope"],
  requestedScope: NonNullable<AutomationFieldResolveContext["scope"]>,
): boolean {
  return (fieldScope === "mail" && requestedScope === "mail")
    || (fieldScope === "attachment" && requestedScope === "matchingAttachments");
}
