import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  isAllowedUpdateRequest,
  secureUpdaterSession,
} from "./update-network.js";

describe("update request guarding", () => {
  it("allows only credential-free HTTPS URLs from the exact origin", () => {
    const allowedOrigin = "https://updates.example.com:8443";

    expect(
      isAllowedUpdateRequest(
        "https://updates.example.com:8443/releases/latest.yml?channel=stable",
        allowedOrigin,
      ),
    ).toBe(true);
    expect(
      isAllowedUpdateRequest(
        "https://updates.example.com/releases/latest.yml",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      isAllowedUpdateRequest(
        "https://updates.example.com:9443/releases/latest.yml",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      isAllowedUpdateRequest(
        "https://cdn.example.com:8443/releases/latest.yml",
        allowedOrigin,
      ),
    ).toBe(false);
  });

  it("allows HTTP URLs only for localhost or private IPv4 origins", () => {
    expect(
      isAllowedUpdateRequest(
        "http://localhost:8123/downloads/windows/x64/latest.yml",
        "http://localhost:8123",
      ),
    ).toBe(true);
    expect(
      isAllowedUpdateRequest(
        "http://127.0.0.44/downloads/windows/x64/latest.yml",
        "http://127.0.0.44",
      ),
    ).toBe(true);
  });

  it("rejects public HTTP, custom, malformed, and credential-bearing URLs", () => {
    const allowedOrigin = "https://updates.example.com";

    expect(
      isAllowedUpdateRequest(
        "http://updates.example.com/releases/latest.yml",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      isAllowedUpdateRequest(
        "file:///C:/updates/latest.yml",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      isAllowedUpdateRequest("wemail://updates/latest.yml", allowedOrigin),
    ).toBe(false);
    expect(isAllowedUpdateRequest("not a URL", allowedOrigin)).toBe(false);
    expect(
      isAllowedUpdateRequest(
        "https://user:secret@updates.example.com/releases/latest.yml",
        allowedOrigin,
      ),
    ).toBe(false);
  });

  it("registers one all-URL request handler on the provided session", () => {
    const onBeforeRequest = vi.fn();
    const updaterSession = {
      webRequest: { onBeforeRequest },
    } as unknown as Session;

    expect(
      secureUpdaterSession(updaterSession, ["https://updates.example.com"]),
    ).toBe(updaterSession);
    expect(onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(onBeforeRequest.mock.calls[0]?.[0]).toEqual({ urls: ["<all_urls>"] });
  });

  it("cancels rejected requests and permits allowed requests", () => {
    const onBeforeRequest = vi.fn();
    const updaterSession = {
      webRequest: { onBeforeRequest },
    } as unknown as Session;

    secureUpdaterSession(updaterSession, [
      "https://updates.example.com:8443",
    ]);

    const handler = onBeforeRequest.mock.calls[0]?.[1];
    const callback = vi.fn();

    handler(
      { url: "https://updates.example.com:8443/releases/latest.yml" },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });

    handler(
      { url: "https://updates.example.com/releases/latest.yml" },
      callback,
    );
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  });
});
