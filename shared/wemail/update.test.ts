import { describe, expect, it } from "vitest";
import {
  createInitialUpdateState,
  isNewerReleaseVersion,
  reduceUpdateState,
  type DesktopUpdateBridge,
  type DesktopUpdateState,
  type UpdateEvent,
  type UpdateStatus,
} from "./update.js";

const availableUpdate = {
  version: "1.2.0",
  releaseName: "WeMail 1.2",
  releaseNotes: "Security and reliability improvements.",
  size: 42_000_000,
};

const progress = {
  percent: 50,
  transferred: 21_000_000,
  total: 42_000_000,
  bytesPerSecond: 1_000_000,
};

type FailureEvent = Extract<UpdateEvent, { type: "failed" }>;
type CheckParameters = Parameters<DesktopUpdateBridge["check"]>;
type CheckReturn = ReturnType<DesktopUpdateBridge["check"]>;

const checkParameters: CheckParameters = [];
const checkReturn: CheckReturn = Promise.resolve(createInitialUpdateState("1.1.0", true));
const validCheckSource: DesktopUpdateState["checkSource"] = "manual";

// @ts-expect-error renderer checks cannot select their source
const invalidCheckParameters: CheckParameters = ["manual"];

// @ts-expect-error check sources are limited to startup and manual
const invalidStateCheckSource: DesktopUpdateState["checkSource"] = "background";

const invalidEventCheckSource: UpdateEvent = {
  type: "check-started",
  // @ts-expect-error check-started sources are limited to startup and manual
  source: "background",
};

const validFailureEvents: FailureEvent[] = [
  {
    type: "failed",
    stage: "check",
    errorCode: "NETWORK_UNAVAILABLE",
    checkedAt: "2026-07-18T10:00:00.000Z",
  },
  {
    type: "failed",
    stage: "check",
    errorCode: "UPDATE_SERVER_UNAVAILABLE",
    checkedAt: "2026-07-18T10:00:00.000Z",
  },
  {
    type: "failed",
    stage: "check",
    errorCode: "INVALID_UPDATE_METADATA",
    checkedAt: "2026-07-18T10:00:00.000Z",
  },
  { type: "failed", stage: "download", errorCode: "NETWORK_UNAVAILABLE" },
  {
    type: "failed",
    stage: "download",
    errorCode: "UPDATE_SERVER_UNAVAILABLE",
  },
  {
    type: "failed",
    stage: "download",
    errorCode: "INSUFFICIENT_DISK_SPACE",
  },
  { type: "failed", stage: "download", errorCode: "DOWNLOAD_FAILED" },
  {
    type: "failed",
    stage: "security",
    errorCode: "SECURITY_VERIFICATION_FAILED",
  },
  {
    type: "failed",
    stage: "install",
    errorCode: "INSTALLER_START_FAILED",
  },
];

const invalidCheckFailure: UpdateEvent = {
  type: "failed",
  stage: "check",
  // @ts-expect-error check failures cannot use download error codes
  errorCode: "DOWNLOAD_FAILED",
  checkedAt: "2026-07-18T10:00:00.000Z",
};

const invalidDownloadFailure: UpdateEvent = {
  type: "failed",
  stage: "download",
  // @ts-expect-error download failures cannot use security error codes
  errorCode: "SECURITY_VERIFICATION_FAILED",
};

const invalidSecurityFailure: UpdateEvent = {
  type: "failed",
  stage: "security",
  // @ts-expect-error security failures only accept SECURITY_VERIFICATION_FAILED
  errorCode: "NETWORK_UNAVAILABLE",
};

const invalidInstallFailure: UpdateEvent = {
  type: "failed",
  stage: "install",
  // @ts-expect-error install failures only accept INSTALLER_START_FAILED
  errorCode: "DOWNLOAD_FAILED",
};

void validFailureEvents;
void checkParameters;
void checkReturn;
void validCheckSource;
void invalidCheckParameters;
void invalidStateCheckSource;
void invalidEventCheckSource;
void invalidCheckFailure;
void invalidDownloadFailure;
void invalidSecurityFailure;
void invalidInstallFailure;

const updateStatusRecord: Record<UpdateStatus, true> = {
  disabled: true,
  idle: true,
  checking: true,
  "up-to-date": true,
  available: true,
  downloading: true,
  downloaded: true,
  "install-on-exit": true,
  installing: true,
  "check-failed": true,
  "download-failed": true,
  "security-failed": true,
  "install-failed": true,
};

const updateStatuses = Object.keys(updateStatusRecord) as UpdateStatus[];

function stateWithStatus(status: UpdateStatus): DesktopUpdateState {
  return {
    ...createInitialUpdateState("1.1.0", status !== "disabled"),
    status,
    availableVersion: "1.2.0",
    progress,
  };
}

const transitionCases: Array<{
  name: string;
  event: UpdateEvent;
  allowed: UpdateStatus[];
}> = [
  {
    name: "check-started",
    event: { type: "check-started", source: "manual" },
    allowed: ["idle", "up-to-date", "available", "check-failed", "download-failed"],
  },
  {
    name: "update-available",
    event: {
      type: "update-available",
      update: availableUpdate,
      checkedAt: "2026-07-18T10:00:00.000Z",
    },
    allowed: ["checking"],
  },
  {
    name: "update-not-available",
    event: {
      type: "update-not-available",
      checkedAt: "2026-07-18T10:00:00.000Z",
    },
    allowed: ["checking"],
  },
  { name: "download-started", event: { type: "download-started" }, allowed: ["available", "download-failed"] },
  { name: "download-progress", event: { type: "download-progress", progress }, allowed: ["downloading"] },
  { name: "download-complete", event: { type: "download-complete" }, allowed: ["downloading"] },
  { name: "download-cancelled", event: { type: "download-cancelled" }, allowed: ["downloading"] },
  { name: "available-dismissed", event: { type: "available-dismissed" }, allowed: ["available"] },
  { name: "install-on-exit-selected", event: { type: "install-on-exit-selected" }, allowed: ["downloaded"] },
  { name: "install-started", event: { type: "install-started" }, allowed: ["downloaded", "install-on-exit"] },
  {
    name: "check failed",
    event: {
      type: "failed",
      stage: "check",
      errorCode: "NETWORK_UNAVAILABLE",
      checkedAt: "2026-07-18T10:00:00.000Z",
    },
    allowed: ["checking"],
  },
  {
    name: "download failed",
    event: { type: "failed", stage: "download", errorCode: "DOWNLOAD_FAILED" },
    allowed: ["downloading"],
  },
  {
    name: "security failed",
    event: {
      type: "failed",
      stage: "security",
      errorCode: "SECURITY_VERIFICATION_FAILED",
    },
    allowed: ["downloading"],
  },
  {
    name: "install failed",
    event: {
      type: "failed",
      stage: "install",
      errorCode: "INSTALLER_START_FAILED",
    },
    allowed: ["downloaded", "install-on-exit", "installing"],
  },
];

describe("desktop update state reducer", () => {
  it("follows the successful update lifecycle", () => {
    const initial = createInitialUpdateState("1.1.0", true);
    const checking = reduceUpdateState(initial, {
      type: "check-started",
      source: "manual",
    });
    const available = reduceUpdateState(checking, {
      type: "update-available",
      update: availableUpdate,
      checkedAt: "2026-07-18T10:00:00.000Z",
    });
    const downloading = reduceUpdateState(available, { type: "download-started" });
    const withProgress = reduceUpdateState(downloading, {
      type: "download-progress",
      progress,
    });
    const downloaded = reduceUpdateState(withProgress, { type: "download-complete" });

    expect(initial).toEqual({
      status: "idle",
      enabled: true,
      currentVersion: "1.1.0",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      size: null,
      progress: null,
      lastCheckedAt: null,
      checkSource: null,
      errorCode: null,
      promptSuppressed: false,
    });
    expect(checking).toMatchObject({
      status: "checking",
      checkSource: "manual",
      promptSuppressed: false,
    });
    expect(available).toMatchObject({
      status: "available",
      availableVersion: "1.2.0",
      releaseName: "WeMail 1.2",
      releaseNotes: "Security and reliability improvements.",
      size: 42_000_000,
      lastCheckedAt: "2026-07-18T10:00:00.000Z",
      promptSuppressed: false,
    });
    expect(withProgress).toMatchObject({ status: "downloading", progress });
    expect(downloaded).toMatchObject({ status: "downloaded", progress: null });
  });

  it("records an up-to-date check result", () => {
    const checking = reduceUpdateState(createInitialUpdateState("1.1.0", true), {
      type: "check-started",
      source: "startup",
    });

    expect(
      reduceUpdateState(checking, {
        type: "update-not-available",
        checkedAt: "2026-07-18T10:05:00.000Z",
      }),
    ).toMatchObject({
      status: "up-to-date",
      lastCheckedAt: "2026-07-18T10:05:00.000Z",
      checkSource: "startup",
    });
  });

  it("rejects invalid lifecycle transitions", () => {
    expect(() =>
      reduceUpdateState(createInitialUpdateState("1.1.0", true), {
        type: "download-started",
      }),
    ).toThrow("Invalid update transition: idle -> download-started");
  });

  it("returns a cancelled download to available and clears progress", () => {
    const downloading = reduceUpdateState(
      reduceUpdateState(
        reduceUpdateState(createInitialUpdateState("1.1.0", true), {
          type: "check-started",
          source: "manual",
        }),
        {
          type: "update-available",
          update: availableUpdate,
          checkedAt: "2026-07-18T10:00:00.000Z",
        },
      ),
      { type: "download-started" },
    );
    const withProgress = reduceUpdateState(downloading, {
      type: "download-progress",
      progress,
    });

    expect(reduceUpdateState(withProgress, { type: "download-cancelled" })).toMatchObject({
      status: "available",
      progress: null,
      availableVersion: "1.2.0",
    });
  });

  it("preserves a dismissed prompt for the whole process", () => {
    const checking = reduceUpdateState(createInitialUpdateState("1.1.0", true), {
      type: "check-started",
      source: "manual",
    });
    const available = reduceUpdateState(checking, {
      type: "update-available",
      update: availableUpdate,
      checkedAt: "2026-07-18T10:00:00.000Z",
    });
    const dismissed = reduceUpdateState(available, { type: "available-dismissed" });
    const checkingAgain = reduceUpdateState(dismissed, {
      type: "check-started",
      source: "manual",
    });
    const availableAgain = reduceUpdateState(checkingAgain, {
      type: "update-available",
      update: availableUpdate,
      checkedAt: "2026-07-18T10:10:00.000Z",
    });

    expect(dismissed.promptSuppressed).toBe(true);
    expect(checkingAgain.promptSuppressed).toBe(true);
    expect(availableAgain.promptSuppressed).toBe(true);
    expect(() =>
      reduceUpdateState(createInitialUpdateState("1.1.0", true), {
        type: "available-dismissed",
      }),
    ).toThrow("Invalid update transition: idle -> available-dismissed");
  });

  it("supports install-on-exit and immediate installation", () => {
    const downloaded = {
      ...createInitialUpdateState("1.1.0", true),
      status: "downloaded" as const,
      availableVersion: "1.2.0",
    };
    const installOnExit = reduceUpdateState(downloaded, {
      type: "install-on-exit-selected",
    });

    expect(installOnExit.status).toBe("install-on-exit");
    expect(reduceUpdateState(installOnExit, { type: "install-started" }).status).toBe(
      "installing",
    );
    expect(reduceUpdateState(downloaded, { type: "install-started" }).status).toBe(
      "installing",
    );
    expect(() =>
      reduceUpdateState(createInitialUpdateState("1.1.0", true), {
        type: "install-on-exit-selected",
      }),
    ).toThrow("Invalid update transition: idle -> install-on-exit-selected");
  });

  it.each([
    ["checking", validFailureEvents[0], "check-failed"],
    ["checking", validFailureEvents[1], "check-failed"],
    ["checking", validFailureEvents[2], "check-failed"],
    ["downloading", validFailureEvents[3], "download-failed"],
    ["downloading", validFailureEvents[4], "download-failed"],
    ["downloading", validFailureEvents[5], "download-failed"],
    ["downloading", validFailureEvents[6], "download-failed"],
    ["downloading", validFailureEvents[7], "security-failed"],
    ["installing", validFailureEvents[8], "install-failed"],
  ] as const)("maps %s failures with %j to %s", (status, event, expectedStatus) => {
    const state = {
      ...createInitialUpdateState("1.1.0", true),
      status,
      progress,
    };

    expect(reduceUpdateState(state, event)).toMatchObject({
      status: expectedStatus,
      progress: null,
      errorCode: event.errorCode,
    });
  });

  it("records the timestamp of a failed check", () => {
    const checking = stateWithStatus("checking");

    expect(
      reduceUpdateState(checking, {
        type: "failed",
        stage: "check",
        errorCode: "UPDATE_SERVER_UNAVAILABLE",
        checkedAt: "2026-07-18T10:15:00.000Z",
      }),
    ).toMatchObject({
      status: "check-failed",
      lastCheckedAt: "2026-07-18T10:15:00.000Z",
    });
  });

  it.each(transitionCases)("allows only documented sources for $name", ({ event, allowed }) => {
    for (const status of updateStatuses) {
      if (allowed.includes(status)) {
        expect(() => reduceUpdateState(stateWithStatus(status), event)).not.toThrow();
      } else {
        expect(() => reduceUpdateState(stateWithStatus(status), event)).toThrow(
          `Invalid update transition: ${status} -> ${event.type}`,
        );
      }
    }
  });

  it.each(["security-failed", "install-failed"] as const)(
    "keeps %s terminal for every event category",
    (status) => {
      for (const { event } of transitionCases) {
        expect(() => reduceUpdateState(stateWithStatus(status), event)).toThrow(
          `Invalid update transition: ${status} -> ${event.type}`,
        );
      }
    },
  );

  it("keeps disabled updates fail-closed", () => {
    const disabled = createInitialUpdateState("1.1.0", false);

    expect(disabled.status).toBe("disabled");
    expect(() =>
      reduceUpdateState(disabled, { type: "check-started", source: "manual" }),
    ).toThrow("Invalid update transition: disabled -> check-started");
  });

});

describe("isNewerReleaseVersion", () => {
  it.each([
    ["1.2.3", "1.2.4", true],
    ["1.2.3", "1.3.0", true],
    ["1.2.3", "2.0.0", true],
    ["1.2.3", "1.2.3", false],
    ["1.2.3", "1.2.2", false],
    ["1.2.3", "1.2.4-beta.1", false],
    ["1.2.3", "v1.2.4", false],
    ["1.2.3", "1.2", false],
    ["not-a-version", "1.2.4", false],
    ["1.2.3-beta.1", "1.2.4", false],
    ["1.02.3", "1.2.4", false],
    ["1.2.3", "1.2.4+build.5", false],
  ])("compares %s to %s", (current, candidate, expected) => {
    expect(isNewerReleaseVersion(current, candidate)).toBe(expected);
  });
});
