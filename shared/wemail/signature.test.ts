import { describe, expect, it } from "vitest";
import {
  extractChineseDirectoryName,
  isOriginalEmailDisplayName,
  resolveSignatureIdentity,
} from "./signature.js";

describe("directory-backed signature identity", () => {
  it("extracts the Chinese name from a directory display name", () => {
    expect(extractChineseDirectoryName("eddiewang(王振宇)")).toBe("王振宇");
    expect(extractChineseDirectoryName("eddiewang（王振宇）")).toBe("王振宇");
  });

  it("falls back when the directory has no Chinese name", () => {
    expect(
      resolveSignatureIdentity({
        directoryName: "eddiewang",
        displayName: "eddiewang",
        emailAddress: "eddiewang@example.com",
      }),
    ).toBe("eddiewang");
  });

  it("only treats the email-derived display name as replaceable", () => {
    expect(isOriginalEmailDisplayName("eddiewang", "eddiewang@example.com")).toBe(true);
    expect(isOriginalEmailDisplayName("Eddie Wang", "eddiewang@example.com")).toBe(false);
  });
});
