/**
 * Registry of intelligence capabilities. The composition root registers
 * each capability once; the orchestrator and queue runner query the
 * registry for dispatch and lane configuration.
 */

import type { CapabilityDescriptor } from "./CapabilityDescriptor.js";
import type { IntelligenceJobType } from "../../../shared/wemail/intelligence.js";

export class CapabilityRegistry {
  private readonly caps = new Map<IntelligenceJobType, CapabilityDescriptor>();

  register(descriptor: CapabilityDescriptor): void {
    if (this.caps.has(descriptor.type)) {
      throw new Error(`Capability already registered: ${descriptor.type}`);
    }
    this.caps.set(descriptor.type, descriptor);
  }

  get(type: IntelligenceJobType): CapabilityDescriptor | undefined {
    return this.caps.get(type);
  }

  getAll(): CapabilityDescriptor[] {
    return Array.from(this.caps.values());
  }

  has(type: IntelligenceJobType): boolean {
    return this.caps.has(type);
  }
}
