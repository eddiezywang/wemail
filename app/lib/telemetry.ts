import type {
  TelemetryArgs,
  TelemetryEventName,
} from "../../shared/wemail/telemetry";
import {
  countBucket,
  durationBucket,
  normalizeTelemetryErrorClass,
} from "../../shared/wemail/telemetry";

export { countBucket, durationBucket, normalizeTelemetryErrorClass };

export function trackTelemetry(event: TelemetryEventName, args: TelemetryArgs = {}): void {
  if (typeof window === "undefined") return;
  window.wemailDesktop?.telemetry?.track(event, args);
}

export function telemetrySurface(pathname: string): string {
  if (pathname === "/") return "inbox";
  const first = pathname.split("/").filter(Boolean)[0] ?? "inbox";
  const surfaces: Record<string, string> = {
    folder: "folder",
    "smart-tags": "smart_tags",
    message: "message",
    snoozed: "snoozed",
    scheduled: "scheduled",
    todos: "todos",
    actions: "actions",
    automation: "automation",
    digests: "digests",
    notifications: "notifications",
    workspace: "workspace",
    directory: "directory",
    onboarding: "onboarding",
    settings: "settings",
  };
  return surfaces[first] ?? "other";
}

export async function trackPromise<T>(
  operation: () => Promise<T>,
  events: {
    attempted?: TelemetryEventName;
    succeeded: TelemetryEventName;
    failed: TelemetryEventName;
    args?: TelemetryArgs;
    successArgs?: (value: T, durationMs: number) => TelemetryArgs;
  },
): Promise<T> {
  const startedAt = performance.now();
  if (events.attempted) trackTelemetry(events.attempted, events.args);
  try {
    const value = await operation();
    const elapsed = performance.now() - startedAt;
    trackTelemetry(events.succeeded, {
      ...events.args,
      duration_bucket: durationBucket(elapsed),
      ...events.successArgs?.(value, elapsed),
    });
    return value;
  } catch (error) {
    trackTelemetry(events.failed, {
      ...events.args,
      duration_bucket: durationBucket(performance.now() - startedAt),
      error_class: normalizeTelemetryErrorClass(error),
      reason: "request_failed",
    });
    throw error;
  }
}
