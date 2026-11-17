export function clampDeadline(deadlineMs: number, receivedAt: number, maxDurationMs: number): number {
  return Math.min(deadlineMs, receivedAt + maxDurationMs);
}

/** Check the expanded payload size while rejecting cycles, but allow shared values. */
export function payloadWithinBounds(value: unknown, maxBytes: number, maxNodes: number): boolean {
  return payloadBoundsFailure(value, maxBytes, maxNodes) === null;
}

export function payloadBoundsFailure(value: unknown, maxBytes: number, maxNodes: number): "nodes" | "bytes" | "cycle" | null {
  const pending: Array<{ value: unknown; exit?: true }> = [{ value }];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    const current = item.value;
    if (item.exit) {
      ancestors.delete(current as object);
      continue;
    }
    if (++nodes > maxNodes) return "nodes";
    if (typeof current === "string") bytes += current.length * 2;
    else if (typeof current === "number" || typeof current === "bigint") bytes += 16;
    else if (typeof current === "boolean") bytes += 4;
    else if (current && typeof current === "object") {
      if (ancestors.has(current)) return "cycle";
      ancestors.add(current);
      pending.push({ value: current, exit: true });
      if (Array.isArray(current)) {
        if (current.length + nodes > maxNodes) return "nodes";
        for (const nested of current) pending.push({ value: nested });
      } else {
        for (const [key, nested] of Object.entries(current)) {
          bytes += key.length * 2;
          pending.push({ value: nested });
        }
      }
    }
    if (bytes > maxBytes) return "bytes";
  }
  return null;
}
