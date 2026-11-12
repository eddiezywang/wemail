import { createHash } from "node:crypto";
import type { AutomationPipelineStep } from "../../../../shared/wemail/automation.js";
import type {
  AutomationCapabilityDescriptor,
  AutomationProvider,
  CompiledAutomationStep,
} from "./AutomationProvider.js";
import type { ConfigurationIssue } from "../../../../shared/wemail/configuration.js";
import { ConfigurationFailureAdapter } from "../../configuration/ConfigurationFailureAdapter.js";

export interface AutomationProviderDiscoveryStatus {
  provider: string;
  status: "available" | "unavailable";
  capabilityCount: number;
  issue?: ConfigurationIssue;
}

export interface AutomationCapabilityDiscoveryResult {
  capabilities: AutomationCapabilityDescriptor[];
  providers: AutomationProviderDiscoveryStatus[];
}

export class AutomationProviderRegistry {
  private readonly providers = new Map<string, AutomationProvider>();
  private readonly failures = new ConfigurationFailureAdapter();

  register(provider: AutomationProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`automation-provider-already-registered:${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): AutomationProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviderIds(): string[] {
    return [...this.providers.keys()].sort();
  }

  async discover(input: { query?: string; provider?: string; capability?: string } = {}): Promise<AutomationCapabilityDescriptor[]> {
    return (await this.discoverWithStatus(input)).capabilities;
  }

  async discoverWithStatus(
    input: { query?: string; provider?: string; capability?: string } = {},
  ): Promise<AutomationCapabilityDiscoveryResult> {
    const providers = input.provider ? [this.providers.get(input.provider)].filter(Boolean) as AutomationProvider[] : [...this.providers.values()];
    if (input.provider && providers.length === 0) {
      const unavailable = this.failures.unavailable({
        code: "provider_unavailable",
        phase: "discover_capabilities",
        provider: input.provider,
        affectedScope: [`provider:${input.provider}`],
      });
      return {
        capabilities: [],
        providers: [{
          provider: input.provider,
          status: "unavailable",
          capabilityCount: 0,
          issue: unavailable.issue,
        }],
      };
    }
    const settled = await Promise.allSettled(
      providers.map((provider) =>
        provider.discover({
          query: input.query,
          capability: input.capability,
        }),
      ),
    );
    const capabilities: AutomationCapabilityDescriptor[] = [];
    const statuses = settled.map((result, index) => {
      const provider = providers[index]!;
      if (result.status === "fulfilled") {
        capabilities.push(...result.value);
        return {
          provider: provider.id,
          status: "available" as const,
          capabilityCount: result.value.length,
        };
      }
      const failure = this.failures.failed({
        error: result.reason,
        phase: "discover_capabilities",
        provider: provider.id,
        capability: input.capability ?? input.query,
      });
      return {
        provider: provider.id,
        status: "unavailable" as const,
        capabilityCount: 0,
        issue: failure.issue,
      };
    });
    return {
      capabilities: capabilities.sort((a, b) =>
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
      ),
      providers: statuses,
    };
  }

  async resolve(providerId: string, capabilityId: string): Promise<AutomationCapabilityDescriptor | undefined> {
    const provider = this.providers.get(providerId);
    if (!provider) return undefined;
    return (await provider.discover({ capability: capabilityId })).find((item) => item.id === capabilityId);
  }

  async compile(step: AutomationPipelineStep): Promise<CompiledAutomationStep> {
    const provider = this.providers.get(step.provider);
    if (!provider) throw new Error(`automation-provider-unavailable:${step.provider}`);
    const descriptor = await this.resolve(step.provider, step.capability);
    if (!descriptor) throw new Error(`automation-capability-unavailable:${step.provider}/${step.capability}`);
    if (step.capabilityFingerprint && step.capabilityFingerprint !== descriptor.fingerprint) {
      const compatibility = provider.checkCompatibility(step.capabilityFingerprint, descriptor);
      if (compatibility !== "identical" && compatibility !== "compatible") {
        throw new Error(`automation-capability-drift:${step.provider}/${step.capability}:${compatibility}`);
      }
    }
    return provider.compile(descriptor, { ...step, capabilityFingerprint: descriptor.fingerprint });
  }

  async fingerprint(): Promise<string> {
    const descriptors = (await this.discoverWithStatus()).capabilities;
    return createHash("sha256").update(JSON.stringify(descriptors.map((item) => ({
      provider: item.provider,
      id: item.id,
      fingerprint: item.fingerprint,
      risk: item.risk,
    })))).digest("hex");
  }
}

export function descriptorFingerprint(value: Omit<AutomationCapabilityDescriptor, "fingerprint">): string {
  return createHash("sha256").update(stableStringify({
    provider: value.provider,
    id: value.id,
    version: value.version,
    kind: value.kind,
    inputSchema: value.inputSchema,
    outputSchema: value.outputSchema,
    risk: value.risk,
    sideEffects: value.sideEffects,
    idempotency: value.idempotency,
  })).digest("hex");
}

export function legacyDescriptorFingerprint(
  value: Omit<AutomationCapabilityDescriptor, "fingerprint"> | AutomationCapabilityDescriptor,
): string {
  const { fingerprint: _ignored, ...descriptor } = value as AutomationCapabilityDescriptor;
  return createHash("sha256").update(stableStringify(descriptor)).digest("hex");
}

export function schemaHash(schema: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(schema)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
