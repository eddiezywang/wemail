import type { AutomationPipelineStep } from "../../../../shared/wemail/automation.js";
import type {
  AutomationCapabilityDescriptor,
  AutomationProvider,
  AutomationProviderContext,
  AutomationStepPreview,
  AutomationStepResult,
  CapabilityCompatibility,
  CompiledAutomationStep,
} from "./AutomationProvider.js";
import { legacyDescriptorFingerprint } from "./AutomationProviderRegistry.js";

export abstract class BaseAutomationProvider implements AutomationProvider {
  abstract readonly id: string;
  abstract readonly version: string;
  protected abstract capabilities(): Promise<AutomationCapabilityDescriptor[]> | AutomationCapabilityDescriptor[];

  async discover(query: { query?: string; capability?: string } = {}): Promise<AutomationCapabilityDescriptor[]> {
    const capabilities = await this.capabilities();
    return capabilities.filter((item) => {
      if (query.capability && item.id !== query.capability) return false;
      if (!query.query) return true;
      const needle = query.query.toLowerCase();
      return `${item.id} ${item.label} ${item.description}`.toLowerCase().includes(needle);
    });
  }

  async compile(capability: AutomationCapabilityDescriptor, step: AutomationPipelineStep): Promise<CompiledAutomationStep> {
    return { ...step, capabilityFingerprint: capability.fingerprint, descriptor: capability };
  }

  async validate(_step: CompiledAutomationStep, _input: Record<string, unknown>, _context: AutomationProviderContext): Promise<string[]> {
    return [];
  }

  abstract preview(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepPreview>;
  abstract execute(step: CompiledAutomationStep, input: Record<string, unknown>, context: AutomationProviderContext): Promise<AutomationStepResult>;

  checkCompatibility(previousFingerprint: string, current: AutomationCapabilityDescriptor): CapabilityCompatibility {
    if (previousFingerprint === current.fingerprint) return "identical";
    return previousFingerprint === legacyDescriptorFingerprint(current)
      ? "compatible"
      : "breaking";
  }
}
