import type {
  IntegrationConnectionId,
  IntegrationConnectionSnapshot,
  IntegrationConnectionSummary,
} from "../../../shared/wemail/channels.js";
import type { WecliHealthPort } from "../skills/wecliPort.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { ChannelManagementService } from "./ChannelManagementService.js";

export const INTEGRATION_CONNECTED_FRESH_MS = 24 * 60 * 60 * 1_000;

/**
 * Hard ceiling on a single bot-channel detect inside a refresh. The WeCom /
 * Feishu transport probe awaits the platform long-connection and has no
 * internal timeout, so without this deadline a hung transport probe would
 * stall the whole refresh. Bounded detects keep {@link IntegrationStatusService.refresh}
 * responsive regardless of any single channel's state.
 */
const CHANNEL_DETECT_TIMEOUT_MS = 12_000;

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`channel-detect-timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

export class IntegrationStatusService {
  /**
   * In-flight refreshes keyed by scope: `"wecli"`, a bot platform, or `"*"` for
   * a full refresh. Per-key dedup means a scoped WeCLI refresh never waits on
   * — and never coalesces with — a slow or hung bot-channel refresh.
   */
  private readonly refreshInFlight = new Map<
    string,
    Promise<IntegrationConnectionSnapshot>
  >();

  constructor(
    private readonly connections: ChannelConnectionRepository,
    private readonly management: ChannelManagementService,
    /** Absent in the open edition: no WeCLI connection entry is surfaced. */
    private readonly wecliHealth?: WecliHealthPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Optional hook invoked once after WeCLI is detected as installed/connected.
   * Used by the connection center to best-effortly download the wecli-usage
   * skill via pm-cli. Set after construction (in app wiring) because the
   * WecliSetupService is created later than this service.
   */
  private wecliUsageEnsurer?: () => Promise<void>;
  private wecliUsageEnsureInFlight = false;
  private wecliUsageEnsureAttempted = false;

  setWecliUsageEnsurer(fn: () => Promise<void>): void {
    this.wecliUsageEnsurer = fn;
  }

  getCached(): IntegrationConnectionSnapshot {
    const observed = this.connections.listObservations();
    const latestById = new Map<
      IntegrationConnectionSummary["id"],
      IntegrationConnectionSummary
    >();
    for (const entry of observed) {
      if (!latestById.has(entry.id)) latestById.set(entry.id, entry);
    }
    const defaults: IntegrationConnectionSummary[] = [
      // P2.5: the WeCLI connection entry is edition-only. Without a health
      // port the open edition exposes just the two bot platforms, and any
      // stale wecli observation left in the DB stays invisible.
      ...(this.wecliHealth
        ? [{
            id: "wecli" as const,
            label: "WeCLI",
            state: "unknown" as const,
            observedAt: null,
            nextAction: "检测 WeCLI",
          }]
        : []),
      {
        id: "feishu",
        label: "飞书",
        state: this.connections.listProfiles("feishu").length
          ? "unknown"
          : "not_configured",
        observedAt: null,
        nextAction: "连接飞书机器人",
      },
      {
        id: "wecom",
        label: "企业微信",
        state: this.connections.listProfiles("wecom").length
          ? "unknown"
          : "not_configured",
        observedAt: null,
        nextAction: "连接企业微信机器人",
      },
    ];
    return {
      entries: defaults.map((fallback) => {
        const retained = latestById.get(fallback.id) ?? fallback;
        if (
          retained.state === "connected" &&
          retained.observedAt &&
          this.now().getTime() - Date.parse(retained.observedAt) >
            INTEGRATION_CONNECTED_FRESH_MS
        ) {
          return {
            ...retained,
            state: "unknown" as const,
            reasonCode: "observation-stale",
            nextAction: "等待启动检测或手动检测",
          };
        }
        return retained;
      }),
      loadedAt: this.now().toISOString(),
    };
  }

  /**
   * Refresh connection observations. Pass an `id` to detect only that channel:
   * `"wecli"` runs just the WeCLI health check, a bot platform runs only that
   * platform's profiles, and omitting it refreshes everything. The scoping is
   * what keeps the WeCLI probe result from being blocked by WeCom/Feishu
   * detects.
   */
  refresh(id?: IntegrationConnectionId): Promise<IntegrationConnectionSnapshot> {
    const key = id ?? "*";
    const existing = this.refreshInFlight.get(key);
    if (existing) return existing;
    const next = this.doRefresh(id).finally(() =>
      this.refreshInFlight.delete(key),
    );
    this.refreshInFlight.set(key, next);
    return next;
  }

  subscribe(listener: (snapshot: IntegrationConnectionSnapshot) => void) {
    return this.connections.onObservationChanged(() =>
      listener(this.getCached()),
    );
  }

  private async doRefresh(
    id?: IntegrationConnectionId,
  ): Promise<IntegrationConnectionSnapshot> {
    const tasks: Promise<unknown>[] = [];
    if (this.wecliHealth && (id === undefined || id === "wecli")) {
      tasks.push(this.detectWecli());
    }
    if (id !== "wecli") {
      // Bot detects are scoped per platform and bounded by a deadline so a
      // hung transport probe can never stall the snapshot. A scoped WeCLI
      // refresh skips this block entirely.
      const platform = id === "feishu" || id === "wecom" ? id : undefined;
      for (const profile of this.connections.listProfiles(platform)) {
        tasks.push(this.detectProfileWithDeadline(profile.id));
      }
    }
    await Promise.allSettled(tasks);
    return this.getCached();
  }

  private async detectWecli(): Promise<void> {
    if (!this.wecliHealth) return;
    const status = await this.wecliHealth.check();
    const metadata: Record<string, unknown> = {};
    if (status.version) metadata.version = status.version;
    if (status.binary) metadata.binary = status.binary;
    if (status.daemon) metadata.daemon = status.daemon;
    if (status.extension) metadata.extension = status.extension;
    // Edition-supplied download URL travels over the wire so the open tree
    // never hardcodes an internal host (P2.5 boundary constraint).
    if (status.extensionDownloadUrl) metadata.extensionDownloadUrl = status.extensionDownloadUrl;
    this.connections.upsertObservation({
      entryKey: "wecli",
      integrationId: "wecli",
      state: status.connected ? "connected" : "disconnected",
      reasonCode: status.connected
        ? undefined
        : status.state === "missing"
          ? "wecli-not-installed"
          : "wecli-doctor-failed",
      nextAction: status.connected ? undefined : "检查或安装 WeCLI",
      observedAt: status.checkedAt,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });

    // Once WeCLI is detected as installed, best-effortly ensure the
    // wecli-usage skill is downloaded via pm-cli. Runs at most once per
    // process lifetime (success or failure) so repeated refreshes don't
    // re-trigger the install. Never awaited — detection must stay responsive.
    if (status.installed && this.wecliUsageEnsurer && !this.wecliUsageEnsureAttempted && !this.wecliUsageEnsureInFlight) {
      this.wecliUsageEnsureInFlight = true;
      this.wecliUsageEnsureAttempted = true;
      void this.wecliUsageEnsurer()
        .catch(() => {
          // Best-effort; failures are not surfaced through the integration snapshot.
        })
        .finally(() => {
          this.wecliUsageEnsureInFlight = false;
        });
    }
  }

  private detectProfileWithDeadline(profileId: string): Promise<void> {
    return withDeadline(
      this.management.detect(profileId).then(() => undefined),
      CHANNEL_DETECT_TIMEOUT_MS,
    );
  }
}
