import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createShortcutController, evaluateShortcutState } from "./shortcuts.js";

const EXE = "C:\\Apps\\WeMail\\WeMail.exe";
const DESKTOP = "C:\\Users\\u\\Desktop";
const START_MENU =
  "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";

function makeOptions(
  overrides: Partial<Parameters<typeof createShortcutController>[0]> = {},
) {
  return {
    desktopPath: DESKTOP,
    startMenuPath: START_MENU,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "wemail-shortcuts-")),
    currentExe: EXE,
    ...overrides,
  };
}

function fakeRunPs(targetByPath: Record<string, string>) {
  return async (script: string) => {
    const lines: string[] = [];
    for (const [lnkPath, target] of Object.entries(targetByPath)) {
      if (script.includes(`CreateShortcut('${lnkPath}')`) && !script.includes("$target =")) {
        lines.push(`${lnkPath}\t${target || "<wemail-missing>"}`);
      }
    }
    if (script.includes("$target =")) {
      expect(script).toMatch(/WScript\.Shell/);
      expect(script).toMatch(/IconLocation/);
      return "OK";
    }
    return lines.join("\n");
  };
}

describe("shortcut controller", () => {
  it("prompts when shortcuts are missing or point elsewhere", async () => {
    const options = makeOptions();
    const controller = createShortcutController({
      ...options,
      runPs: fakeRunPs({
        [path.join(DESKTOP, "WeMail.lnk")]: "",
        [path.join(START_MENU, "WeMail.lnk")]: "C:\\Old\\WeMail.exe",
      }),
    });
    const status = await controller.status();
    expect(status.entries.length).toBe(2);
    expect(status.prompt).toBe(true);
    expect(status.entries[0].exists).toBe(false);
    expect(status.entries[1].correct).toBe(false);
    fs.rmSync(options.dataDir, { recursive: true, force: true });
  });

  it("stays quiet when both shortcuts already match the running exe", async () => {
    const options = makeOptions();
    const controller = createShortcutController({
      ...options,
      runPs: fakeRunPs({
        [path.join(DESKTOP, "WeMail.lnk")]: EXE,
        [path.join(START_MENU, "WeMail.lnk")]: EXE,
      }),
    });
    const status = await controller.status();
    expect(status.prompt).toBe(false);
    fs.rmSync(options.dataDir, { recursive: true, force: true });
  });

  it("dismiss suppresses the prompt for the same exe but not for a new one", async () => {
    const targetByPath = {
      [path.join(DESKTOP, "WeMail.lnk")]: "",
      [path.join(START_MENU, "WeMail.lnk")]: "",
    };
    const options = makeOptions();
    const controller = createShortcutController({
      ...options,
      runPs: fakeRunPs(targetByPath),
    });
    controller.dismiss();
    const quiet = await controller.status();
    expect(quiet.dismissed).toBe(true);
    expect(quiet.prompt).toBe(false);

    const moved = createShortcutController({
      ...options,
      currentExe: "D:\\NewPlace\\WeMail.exe",
      runPs: fakeRunPs(targetByPath),
    });
    expect((await moved.status()).prompt).toBe(true);
    fs.rmSync(options.dataDir, { recursive: true, force: true });
  });

  it("fix rewrites both shortcuts and clears the dismissal marker", async () => {
    const options = makeOptions();
    const controller = createShortcutController({
      ...options,
      runPs: fakeRunPs({
        [path.join(DESKTOP, "WeMail.lnk")]: "",
        [path.join(START_MENU, "WeMail.lnk")]: "",
      }),
    });
    controller.dismiss();
    await controller.fix();
    expect(fs.existsSync(path.join(options.dataDir, "shortcut-prompt.json"))).toBe(false);
    fs.rmSync(options.dataDir, { recursive: true, force: true });
  });
});

describe("evaluateShortcutState", () => {
  it("ignores target case and surrounding whitespace (Windows paths)", () => {
    const entries = [
      {
        location: "desktop" as const,
        path: "D:\\x\\WeMail.lnk",
        exists: true,
        target: "  c:\\apps\\wemail\\wemail.exe ",
        correct: true,
      },
    ];
    expect(
      evaluateShortcutState(entries, "C:\\Apps\\WeMail\\WeMail.exe", false).prompt,
    ).toBe(false);
    expect(
      evaluateShortcutState(
        [{ ...entries[0], target: "C:\\Other\\WeMail.exe" }],
        "C:\\Apps\\WeMail\\WeMail.exe",
        false,
      ).prompt,
    ).toBe(true);
  });
});
