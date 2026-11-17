import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsToastXml,
  configureDesktopNotifications,
  showDesktopNotificationWith,
} from "./notifications.js";

describe("notifications", () => {
  it("sets the production Windows AppUserModelID so toast notifications can appear", () => {
    const app = {
      setAppUserModelId: vi.fn(),
    };

    configureDesktopNotifications(app, "win32", {});

    expect(app.setAppUserModelId).toHaveBeenCalledWith("com.wemail.app");
  });

  it("uses the stable production identity for the Windows dev shell", () => {
    const app = {
      setAppUserModelId: vi.fn(),
    };

    configureDesktopNotifications(app, "win32", {
      VITE_DEV_SERVER_URL: "http://localhost:5173",
    }, "D:\\git\\wemail\\node_modules\\electron\\dist\\WeMailDesktop.exe");

    expect(app.setAppUserModelId).toHaveBeenCalledWith("com.wemail.app");
  });

  it("does not require an AppUserModelID on non-Windows platforms", () => {
    const app = {
      setAppUserModelId: vi.fn(),
    };

    configureDesktopNotifications(app, "darwin");

    expect(app.setAppUserModelId).not.toHaveBeenCalled();
  });

  it("reports whether a desktop notification was shown", () => {
    const show = vi.fn();
    const notificationApi = {
      isSupported: () => true,
      create: vi.fn(() => ({ show })),
    };

    const result = showDesktopNotificationWith(
      notificationApi,
      "Sender",
      "Subject",
      "D:\\WeMail\\resources\\assets\\wemail.ico",
    );

    expect(result).toEqual({ supported: true, shown: true });
    expect(notificationApi.create).toHaveBeenCalledWith({
      title: "Sender",
      body: "Subject",
      icon: "D:\\WeMail\\resources\\assets\\wemail.ico",
    });
    expect(show).toHaveBeenCalledOnce();
  });

  it("renders privacy-safe Windows Toast XML with escaped sender and subject", () => {
    const xml = buildWindowsToastXml({
      title: `Alice & "Bob"`,
      lines: [`Budget <Q4> isn't final`],
      icon: "D:\\WeMail\\resources\\assets\\wemail-256.png",
      launch: "wemail:%7B%22kind%22%3A%22mail%22%7D",
      actions: [
        {
          label: "打开",
          arguments: "wemail:%7B%22action%22%3A%22open%22%7D",
        },
      ],
      silent: true,
    });

    expect(xml).toContain("Alice &amp; &quot;Bob&quot;");
    expect(xml).toContain("Budget &lt;Q4&gt; isn&apos;t final");
    expect(xml).toContain("placement=\"appLogoOverride\"");
    expect(xml).toContain("wemail-256.png");
    expect(xml).toContain("<audio silent=\"true\"/>");
    expect(xml).toContain("placement=\"attribution\">WeMail</text>");
    expect(xml).not.toContain("body preview");
  });

  it("passes custom Toast XML and sound preference to Electron", () => {
    const show = vi.fn();
    const notificationApi = {
      isSupported: () => true,
      create: vi.fn(() => ({ show })),
    };

    showDesktopNotificationWith(notificationApi, {
      title: "Alice",
      body: "Subject",
      icon: "D:\\WeMail\\resources\\assets\\wemail-256.png",
      toastXml: "<toast/>",
      silent: true,
      urgency: "normal",
      timeoutType: "default",
    });

    expect(notificationApi.create).toHaveBeenCalledWith({
      title: "Alice",
      body: "Subject",
      icon: "D:\\WeMail\\resources\\assets\\wemail-256.png",
      toastXml: "<toast/>",
      silent: true,
      urgency: "normal",
      timeoutType: "default",
    });
    expect(show).toHaveBeenCalledOnce();
  });

  it("routes native click and action events through explicit handlers", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const onClick = vi.fn();
    const onAction = vi.fn();
    const notificationApi = {
      isSupported: () => true,
      create: vi.fn(() => ({
        show: vi.fn(),
        on: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
        },
      })),
    };

    showDesktopNotificationWith(
      notificationApi,
      { title: "Alice", body: "Subject" },
      { onClick, onAction },
    );
    listeners.get("click")?.({});
    listeners.get("action")?.({ actionIndex: 1 }, 1, -1);

    expect(onClick).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(1);
  });

  it("does not construct notifications when the platform does not support them", () => {
    const notificationApi = {
      isSupported: () => false,
      create: vi.fn(),
    };

    const result = showDesktopNotificationWith(notificationApi, "Sender", "Subject");

    expect(result).toEqual({ supported: false, shown: false });
    expect(notificationApi.create).not.toHaveBeenCalled();
  });
});
