import { readFileSync } from "node:fs";

function token(css: string, name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Missing color token: ${name}`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

describe("theme text contrast contracts", () => {
  const claude = readFileSync(new URL("./themes/claude.css", import.meta.url), "utf8");
  const dark = readFileSync(new URL("./themes/dark.css", import.meta.url), "utf8");

  it.each([
    ["claude ink-3 on canvas", token(claude, "ink-3"), token(claude, "canvas")],
    ["claude ink-4 on canvas", token(claude, "ink-4"), token(claude, "canvas")],
    ["claude coral on canvas", token(claude, "coral"), token(claude, "canvas")],
    ["dark ink-4 on paper-2", token(dark, "ink-4"), token(dark, "paper-2")],
  ])("keeps %s at WCAG AA for small text", (_label, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
