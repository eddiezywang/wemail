import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadUpdatePolicy, parseUpdatePolicy } from "./update-policy.js";

describe("packaged update policy", () => {
  it("returns a disabled policy unless enabled is exactly true", () => {
    expect(
      parseUpdatePolicy(
        JSON.stringify({
          enabled: "true",
          feedUrl: "https://untrusted.example.com/releases",
          platform: "darwin",
          arch: "arm64",
        }),
        "win32",
        "x64",
      ),
    ).toEqual({
      enabled: false,
      feedUrls: null,
      allowedOrigins: null,
      platform: "win32",
      arch: "x64",
    });

    expect(parseUpdatePolicy("{}", "linux", "arm64")).toEqual({
      enabled: false,
      feedUrls: null,
      allowedOrigins: null,
      platform: "linux",
      arch: "arm64",
    });
  });

  it("treats non-record JSON values as disabled policies", () => {
    const expected = {
      enabled: false,
      feedUrls: null,
      allowedOrigins: null,
      platform: "win32",
      arch: "x64",
    };

    expect(parseUpdatePolicy("null", "win32", "x64")).toEqual(expected);
    expect(parseUpdatePolicy("[]", "win32", "x64")).toEqual(expected);
    expect(parseUpdatePolicy('"enabled"', "win32", "x64")).toEqual(expected);
  });

  it("parses and normalizes an enabled policy", () => {
    expect(
      parseUpdatePolicy(
        JSON.stringify({
          enabled: true,
          feedUrls: [
            "https://updates.example.com:8443/releases/",
            "https://fallback.example.com/releases/",
          ],
          platform: "win32",
          arch: "x64",
        }),
        "win32",
        "x64",
      ),
    ).toEqual({
      enabled: true,
      feedUrls: [
        "https://updates.example.com:8443/releases",
        "https://fallback.example.com/releases",
      ],
      allowedOrigins: [
        "https://updates.example.com:8443",
        "https://fallback.example.com",
      ],
      platform: "win32",
      arch: "x64",
    });
  });

  it("allows private IPv4 HTTP feeds for internal update servers", () => {
    expect(
      parseUpdatePolicy(
        JSON.stringify({
          enabled: true,
          feedUrl: "http://127.0.0.44/downloads/windows/x64/",
          platform: "win32",
          arch: "x64",
        }),
        "win32",
        "x64",
      ),
    ).toEqual({
      enabled: true,
      feedUrls: ["http://127.0.0.44/downloads/windows/x64"],
      allowedOrigins: ["http://127.0.0.44"],
      platform: "win32",
      arch: "x64",
    });
  });

  it("rejects malformed JSON deterministically", () => {
    expect(() => parseUpdatePolicy("{", "win32", "x64")).toThrowError(
      "Invalid update policy JSON",
    );
  });

  it("rejects enabled policies without a string feed URL", () => {
    expect(() =>
      parseUpdatePolicy(
        JSON.stringify({ enabled: true, platform: "win32", arch: "x64" }),
        "win32",
        "x64",
      ),
    ).toThrowError("Enabled update policy requires at least one feed URL");
  });

  it("rejects malformed, insecure, and credential-bearing feed URLs", () => {
    expect(() =>
      parseUpdatePolicy(
        JSON.stringify({
          enabled: true,
          feedUrl: "not a URL",
          platform: "win32",
          arch: "x64",
        }),
        "win32",
        "x64",
      ),
    ).toThrowError("Update feed URL is invalid");

    expect(() =>
      parseUpdatePolicy(
        JSON.stringify({
          enabled: true,
          feedUrl: "http://updates.example.com/releases",
          platform: "win32",
          arch: "x64",
        }),
        "win32",
        "x64",
      ),
    ).toThrowError(
      "Update feed URL must use HTTPS unless it targets localhost or a private IPv4 address",
    );

    expect(() =>
      parseUpdatePolicy(
        JSON.stringify({
          enabled: true,
          feedUrl: "https://user:secret@updates.example.com/releases",
          platform: "win32",
          arch: "x64",
        }),
        "win32",
        "x64",
      ),
    ).toThrowError("Update feed URL must not include credentials");
  });

  it("rejects enabled policies for a different platform or architecture", () => {
    expect(() =>
      parseUpdatePolicy(
        JSON.stringify({
          enabled: true,
          feedUrl: "https://updates.example.com/releases",
          platform: "darwin",
          arch: "arm64",
        }),
        "win32",
        "x64",
      ),
    ).toThrowError("Update policy target must match win32/x64");
  });

  it("loads the packaged policy from the application path", async () => {
    const readFile = vi.fn().mockResolvedValue(
      JSON.stringify({
        enabled: true,
        feedUrl: "https://updates.example.com/releases/",
        platform: "win32",
        arch: "x64",
      }),
    );

    await expect(
      loadUpdatePolicy({
        appPath: "/opt/wemail/resources/app.asar",
        platform: "win32",
        arch: "x64",
        readFile,
      }),
    ).resolves.toMatchObject({
      enabled: true,
      feedUrls: ["https://updates.example.com/releases"],
    });
    expect(readFile).toHaveBeenCalledWith(
      path.join(
        "/opt/wemail/resources/app.asar",
        "dist-electron",
        "electron",
        "update-policy.json",
      ),
      "utf8",
    );
  });

  it("returns disabled when the packaged policy file is missing", async () => {
    const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
    const readFile = vi.fn().mockRejectedValue(missingError);

    await expect(
      loadUpdatePolicy({
        appPath: "C:\\Program Files\\WeMail\\resources\\app.asar",
        platform: "win32",
        arch: "x64",
        readFile,
      }),
    ).resolves.toEqual({
      enabled: false,
      feedUrls: null,
      allowedOrigins: null,
      platform: "win32",
      arch: "x64",
    });
  });

  it("propagates non-missing read errors and policy parse errors", async () => {
    const deniedError = Object.assign(new Error("denied"), { code: "EACCES" });

    await expect(
      loadUpdatePolicy({
        appPath: "/app",
        platform: "linux",
        arch: "x64",
        readFile: vi.fn().mockRejectedValue(deniedError),
      }),
    ).rejects.toBe(deniedError);

    await expect(
      loadUpdatePolicy({
        appPath: "/app",
        platform: "linux",
        arch: "x64",
        readFile: vi.fn().mockResolvedValue("{"),
      }),
    ).rejects.toThrowError("Invalid update policy JSON");
  });
});
