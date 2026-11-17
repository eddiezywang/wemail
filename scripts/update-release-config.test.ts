import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseConfig } from "./update-release-config";
import { writeUpdatePolicy } from "./write-update-policy";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("update release config", () => {
  it("derives the immutable Windows x64 feed", () => {
    expect(createReleaseConfig({
      release: true,
      baseUrl: "https://updates.wemail.test/releases/",
      platform: "win32",
      arch: "x64",
      windowsPublisherName: "WeMail Software",
    })).toEqual({
      feedUrl: "https://updates.wemail.test/releases/windows/x64",
      feedUrls: ["https://updates.wemail.test/releases/windows/x64"],
      policy: {
        enabled: true,
        feedUrls: ["https://updates.wemail.test/releases/windows/x64"],
        platform: "win32",
        arch: "x64",
      },
    });
  });

  it("embeds primary and fallback update feeds", () => {
    expect(createReleaseConfig({
      release: true,
      baseUrl: "http://127.0.0.177/downloads/",
      fallbackBaseUrl: "http://127.0.0.190:12580/downloads/",
      platform: "win32",
      arch: "x64",
      windowsPublisherName: "WeMail Software",
    }).policy).toMatchObject({
      enabled: true,
      feedUrls: [
        "http://127.0.0.177/downloads/windows/x64",
        "http://127.0.0.190:12580/downloads/windows/x64",
      ],
    });
  });

  it("allows private IPv4 HTTP feeds for internal update servers", () => {
    expect(createReleaseConfig({
      release: true,
      baseUrl: "http://127.0.0.44/downloads/",
      platform: "win32",
      arch: "x64",
      windowsPublisherName: "WeMail Software",
    }).feedUrl).toBe("http://127.0.0.44/downloads/windows/x64");
  });

  it("derives isolated macOS feeds for Intel and Apple Silicon", () => {
    for (const arch of ["x64", "arm64"] as const) {
      expect(createReleaseConfig({
        release: true,
        baseUrl: "https://updates.wemail.test",
        platform: "darwin",
        arch,
        appleTeamId: "TEAM123456",
      }).feedUrl).toBe(`https://updates.wemail.test/mac/${arch}`);
    }
  });

  it("writes a disabled policy for ordinary local builds on any host", () => {
    expect(createReleaseConfig({
      release: false,
      platform: "linux",
      arch: "arm64",
    })).toEqual({
      feedUrl: null,
      feedUrls: [],
      policy: {
        enabled: false,
        platform: "linux",
        arch: "arm64",
      },
    });
  });

  it("rejects unsupported release targets", () => {
    expect(() => createReleaseConfig({
      release: true,
      baseUrl: "https://updates.wemail.test",
      platform: "win32",
      arch: "arm64",
      windowsPublisherName: "WeMail Software",
    })).toThrow("Unsupported release target: win32/arm64");

    expect(() => createReleaseConfig({
      release: true,
      baseUrl: "https://updates.wemail.test",
      platform: "linux",
      arch: "x64",
    })).toThrow("Unsupported release target: linux/x64");
  });

  it("rejects missing, insecure, credentialed, or malformed feed URLs", () => {
    const base = {
      release: true,
      platform: "win32" as const,
      arch: "x64",
      windowsPublisherName: "WeMail Software",
    };
    expect(() => createReleaseConfig(base)).toThrow(
      "WEMAIL_UPDATE_BASE_URL is required",
    );
    expect(() => createReleaseConfig({ ...base, baseUrl: "http://updates.test" })).toThrow(
      "WEMAIL_UPDATE_BASE_URL must use HTTPS unless it targets localhost or a private IPv4 address",
    );
    expect(() => createReleaseConfig({
      ...base,
      baseUrl: "https://token@updates.test",
    })).toThrow("WEMAIL_UPDATE_BASE_URL must not include credentials");
    expect(() => createReleaseConfig({ ...base, baseUrl: "not a url" })).toThrow(
      "WEMAIL_UPDATE_BASE_URL is invalid",
    );
  });

  it("fails closed when platform signing identity configuration is missing", () => {
    expect(() => createReleaseConfig({
      release: true,
      baseUrl: "https://updates.wemail.test",
      platform: "win32",
      arch: "x64",
    })).toThrow("WEMAIL_WINDOWS_PUBLISHER is required");
    expect(() => createReleaseConfig({
      release: true,
      baseUrl: "https://updates.wemail.test",
      platform: "darwin",
      arch: "arm64",
    })).toThrow("APPLE_TEAM_ID is required");
  });
});

describe("update policy writer", () => {
  it("writes a disabled local policy after desktop compilation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wemail-policy-"));
    temporaryDirectories.push(directory);

    const policy = await writeUpdatePolicy({
      env: {},
      platform: "linux",
      arch: "x64",
      outputDirectory: directory,
    });

    expect(policy).toEqual({ enabled: false, platform: "linux", arch: "x64" });
    expect(JSON.parse(await fs.readFile(
      path.join(directory, "update-policy.json"),
      "utf8",
    ))).toEqual(policy);
  });

  it("requires explicit target variables for release builds", async () => {
    await expect(writeUpdatePolicy({
      env: { WEMAIL_RELEASE_BUILD: "1" },
      platform: "darwin",
      arch: "arm64",
      outputDirectory: "/unused",
    })).rejects.toThrow("WEMAIL_TARGET_PLATFORM is required");
  });
});
