import { describe, expect, it, vi } from "vitest";

const buildFromTemplate = vi.fn((template) => ({ template }));
const createFromPath = vi.fn();
const createEmpty = vi.fn();
const createFromBitmap = vi.fn();
const trayConstructor = vi.fn(function MockTray(this: {
  setToolTip: ReturnType<typeof vi.fn>;
  setContextMenu: ReturnType<typeof vi.fn>;
  setImage: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}) {
  this.setToolTip = vi.fn();
  this.setContextMenu = vi.fn();
  this.setImage = vi.fn();
  this.isDestroyed = vi.fn(() => false);
  this.on = vi.fn();
});

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate,
  },
  Tray: trayConstructor,
  nativeImage: {
    createFromPath,
    createEmpty,
    createFromBitmap,
  },
}));

vi.mock("./assets.js", () => ({
  getRuntimeIconPath: () => "/tmp/wemail-256.png",
}));

describe("tray", () => {
  it("uses a 16px image so the system tray icon does not render oversized", async () => {
    vi.resetModules();
    buildFromTemplate.mockClear();
    createFromPath.mockClear();
    createEmpty.mockClear();
    createFromBitmap.mockClear();
    trayConstructor.mockClear();

    const resizedIcon = { id: "resized-icon" };
    const sourceIcon = {
      resize: vi.fn(() => resizedIcon),
    };
    createFromPath.mockReturnValue(sourceIcon);
    createEmpty.mockReturnValue({ id: "empty-icon" });

    const { createTray } = await import("./tray.js");

    createTray(
      {
        getAppPath: () => process.cwd(),
        getLoginItemSettings: () => ({ openAtLogin: false }),
        setLoginItemSettings: vi.fn(),
        quit: vi.fn(),
      } as never,
      () => null,
    );

    expect(sourceIcon.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
    expect(trayConstructor).toHaveBeenCalledWith(resizedIcon);
  });

  it("opens the window from the tray icon and exposes only startup and quit actions", async () => {
    vi.resetModules();
    buildFromTemplate.mockClear();
    trayConstructor.mockClear();

    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: false }));
    const setLoginItemSettings = vi.fn();
    const restore = vi.fn();
    const show = vi.fn();
    const focus = vi.fn();
    const isMinimized = vi.fn(() => true);
    const quit = vi.fn();
    const win = { isMinimized, restore, show, focus };
    const app = {
      getAppPath: () => process.cwd(),
      getLoginItemSettings,
      setLoginItemSettings,
      quit,
    };

    const { createTray } = await import("./tray.js");
    createTray(app as never, () => win as never);

    const instance = trayConstructor.mock.instances.at(-1)! as unknown as {
      on: ReturnType<typeof vi.fn>;
    };
    const [, clickHandler] = instance.on.mock.calls.find(
      ([eventName]) => eventName === "click",
    )!;
    clickHandler();
    expect(restore).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();

    const [template] = buildFromTemplate.mock.calls.at(-1)! as [Array<{
      label?: string;
      type?: string;
      checked?: boolean;
      click?: (menuItem: { checked: boolean }) => void;
    }>];
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "开机自动启动",
      "separator",
      "Quit",
    ]);
    expect(template[0]).toMatchObject({
      type: "checkbox",
      checked: false,
    });

    template[0].click?.({ checked: true });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it("updates the tray image and tooltip with a bounded badge", async () => {
    vi.resetModules();
    const sourceBitmap = Buffer.alloc(32 * 32 * 4, 64);
    const source32 = { toBitmap: vi.fn(() => sourceBitmap) };
    const baseIcon = {
      resize: vi.fn(() => source32),
    };
    const sourceIcon = { resize: vi.fn(() => baseIcon) };
    const renderedBadge = { id: "badged", isEmpty: vi.fn(() => false) };
    const badgedIcon = { resize: vi.fn(() => renderedBadge) };
    createFromPath.mockReturnValue(sourceIcon);
    createFromBitmap.mockReturnValue(badgedIcon);

    const { createTray } = await import("./tray.js");
    const controller = createTray(
      {
        getAppPath: () => process.cwd(),
        getLoginItemSettings: () => ({ openAtLogin: false }),
        setLoginItemSettings: vi.fn(),
        quit: vi.fn(),
      } as never,
      () => null,
    );
    controller.setBadgeCount(120);

    const instance = trayConstructor.mock.instances.at(-1)! as unknown as {
      setImage: ReturnType<typeof vi.fn>;
      setToolTip: ReturnType<typeof vi.fn>;
    };
    expect(instance.setImage).toHaveBeenCalledWith(renderedBadge);
    expect(instance.setToolTip).toHaveBeenLastCalledWith(
      "WeMail · 99+ 封新邮件",
    );
  });
});
