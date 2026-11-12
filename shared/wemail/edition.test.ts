import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadEditionRuntimeConfig,
  OPEN_EDITION_DEFAULT,
  OPEN_EDITION_FEATURES,
  toPublicEditionInfo,
  validateEditionRuntimeConfig,
  type EditionRuntimeConfig,
} from "./edition.js";

const VALID_INTERNAL: EditionRuntimeConfig = {
  profile: "internal",
  providerPresets: [
    {
      id: "corp",
      label: "企业邮箱",
      domains: ["corp.example"],
      imap: { host: "imap.corp.example", port: 993, secure: true },
      smtp: { host: "smtp.corp.example", port: 465, secure: true },
    },
  ],
  onboarding: { preferredPresetId: "corp", bootToCredentials: true },
  signature: { brandUrl: "https://brand.corp.example" },
  enterpriseDirectory: {
    autoInitDomain: "@corp.example",
    coremailBaseUrl: "https://directory.corp.example",
  },
  features: {
    wecli: true,
    allowanceInvoice: true,
    enterpriseDirectory: true,
    officeSceneDetection: true,
  },
};

describe("validateEditionRuntimeConfig", () => {
  it("accepts the open default", () => {
    expect(validateEditionRuntimeConfig(OPEN_EDITION_DEFAULT)).toEqual(
      OPEN_EDITION_DEFAULT,
    );
  });

  it("accepts a valid internal overlay and passes it through", () => {
    expect(validateEditionRuntimeConfig(VALID_INTERNAL)).toEqual(VALID_INTERNAL);
  });

  it("rejects an unknown profile", () => {
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, profile: "partner" }),
    ).toThrow(/profile/);
  });

  it("rejects duplicate preset ids", () => {
    const config = {
      ...VALID_INTERNAL,
      providerPresets: [VALID_INTERNAL.providerPresets[0], VALID_INTERNAL.providerPresets[0]],
    };
    expect(() => validateEditionRuntimeConfig(config)).toThrow(/duplicate/);
  });

  it("rejects additional preset ids that collide with built-in presets", () => {
    const config = {
      ...VALID_INTERNAL,
      providerPresets: [{ ...VALID_INTERNAL.providerPresets[0], id: "qq" }],
    };
    expect(() => validateEditionRuntimeConfig(config)).toThrow(/built-in/);
  });

  it("rejects a providerPresets value that is explicitly not an array", () => {
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, providerPresets: "corp" }),
    ).toThrow(/providerPresets/);
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, providerPresets: { add: [] } }),
    ).toThrow(/providerPresets/);
  });

  it("rejects presets without a usable label, domains, or secure flags", () => {
    const base = VALID_INTERNAL.providerPresets[0];
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        providerPresets: [{ ...base, label: "" }],
      }),
    ).toThrow(/label/);
    const { id, label, imap, smtp } = base;
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        providerPresets: [{ id, label, imap, smtp }],
      }),
    ).toThrow(/domains/);
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        providerPresets: [{ ...base, smtp: { host: "a", port: 465, secure: "yes" } }],
      }),
    ).toThrow(/secure/);
  });

  it("rejects a non-string preferredPresetId", () => {
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        onboarding: { preferredPresetId: 42, bootToCredentials: true },
      }),
    ).toThrow(/preferredPresetId/);
  });

  it("rejects out-of-range preset ports", () => {
    const config = {
      ...VALID_INTERNAL,
      providerPresets: [
        { ...VALID_INTERNAL.providerPresets[0], imap: { host: "a", port: 99_999, secure: true } },
      ],
    };
    expect(() => validateEditionRuntimeConfig(config)).toThrow(/port/);
  });

  it("rejects non-http(s) signature brand urls", () => {
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        signature: { brandUrl: "javascript:alert(1)" },
      }),
    ).toThrow(/brandUrl/);
  });

  it("rejects credential-bearing urls", () => {
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        signature: { brandUrl: "https://user:pass@corp.example" },
      }),
    ).toThrow(/brandUrl/);
  });

  it("rejects enterprise directory domains without @", () => {
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        enterpriseDirectory: {
          autoInitDomain: "corp.example",
          coremailBaseUrl: "https://directory.corp.example",
        },
      }),
    ).toThrow(/autoInitDomain/);
  });

  it("rejects a non-boolean bootToCredentials", () => {
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        onboarding: { bootToCredentials: "yes" },
      }),
    ).toThrow(/bootToCredentials/);
  });

  it("strips unknown nested fields from provider presets and endpoints", () => {
    const config = validateEditionRuntimeConfig({
      ...VALID_INTERNAL,
      providerPresets: [
        {
          ...VALID_INTERNAL.providerPresets[0],
          enterpriseDirectory: "leak",
          secretExtra: { token: "leak" },
          imap: { ...VALID_INTERNAL.providerPresets[0].imap, evilExtra: "leak" },
        },
      ],
    });
    const preset = config.providerPresets[0];
    expect(Object.keys(preset).sort()).toEqual(["domains", "id", "imap", "label", "smtp"]);
    expect(Object.keys(preset.imap).sort()).toEqual(["host", "port", "secure"]);
    // Nothing unknown survives into the renderer-facing whitelist either.
    expect(JSON.stringify(toPublicEditionInfo(config))).not.toContain("leak");
  });

  it("passes through an all-true features block field by field", () => {
    const config = validateEditionRuntimeConfig(VALID_INTERNAL);
    expect(config.features).toEqual({
      wecli: true,
      allowanceInvoice: true,
      enterpriseDirectory: true,
      officeSceneDetection: true,
    });
  });

  it("accepts a partial features block and keeps unset keys off in the public view", () => {
    const config = validateEditionRuntimeConfig({ ...VALID_INTERNAL, features: { wecli: true } });
    expect(config.features).toEqual({ wecli: true });
    expect(toPublicEditionInfo(config).features).toEqual({
      wecli: true,
      allowanceInvoice: false,
      enterpriseDirectory: false,
      officeSceneDetection: false,
    });
  });

  it("rejects a non-boolean feature switch", () => {
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, features: { wecli: "yes" } }),
    ).toThrow(/features\.wecli/);
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, features: { allowanceInvoice: 1 } }),
    ).toThrow(/features\.allowanceInvoice/);
    expect(() =>
      validateEditionRuntimeConfig({
        ...VALID_INTERNAL,
        features: { officeSceneDetection: null },
      }),
    ).toThrow(/features\.officeSceneDetection/);
  });

  it("rejects a features value that is explicitly not an object", () => {
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, features: "all" }),
    ).toThrow(/features/);
    expect(() =>
      validateEditionRuntimeConfig({ ...VALID_INTERNAL, features: ["wecli"] }),
    ).toThrow(/features/);
  });

  it("strips unknown feature keys (including overlay comments)", () => {
    const config = validateEditionRuntimeConfig({
      ...VALID_INTERNAL,
      features: {
        _comment: "internal module switches",
        wecli: true,
        secretModule: true,
      },
    });
    expect(config.features).toEqual({ wecli: true });
    // Nothing unknown survives into the renderer-facing whitelist either.
    expect(JSON.stringify(toPublicEditionInfo(config))).not.toContain("secretModule");
    expect(JSON.stringify(toPublicEditionInfo(config))).not.toContain("_comment");
  });

  it("omits the features block entirely when the config has none", () => {
    const stripped = { ...VALID_INTERNAL };
    delete (stripped as Partial<EditionRuntimeConfig>).features;
    const config = validateEditionRuntimeConfig(stripped);
    expect("features" in config).toBe(false);
    // The public view still resolves to the all-off shape.
    expect(toPublicEditionInfo(config).features).toEqual(OPEN_EDITION_FEATURES);
  });
});

describe("toPublicEditionInfo", () => {
  it("whitelists renderer-visible fields only", () => {
    const info = toPublicEditionInfo(VALID_INTERNAL);
    expect(Object.keys(info).sort()).toEqual([
      "bootToCredentials",
      "features",
      "preferredPresetId",
      "providerPresets",
      "signatureBrandUrl",
    ]);
    expect(info.preferredPresetId).toBe("corp");
  });

  it("open default yields empty brand url, picker-first onboarding, and all-off features", () => {
    const info = toPublicEditionInfo(OPEN_EDITION_DEFAULT);
    expect(info.bootToCredentials).toBe(false);
    expect(info.signatureBrandUrl).toBe("");
    expect(info.providerPresets).toEqual([]);
    expect(info.features).toEqual(OPEN_EDITION_FEATURES);
    expect(info.features).toEqual({
      wecli: false,
      allowanceInvoice: false,
      enterpriseDirectory: false,
      officeSceneDetection: false,
    });
  });
});

describe("loadEditionRuntimeConfig", () => {
  /** path.join separators differ per platform — normalize to forward slashes. */
  function fsFrom(files: Record<string, string>) {
    const norm = (p: string) => p.replace(/\\/g, "/");
    return {
      exists: (p: string) => norm(p) in files,
      read: (p: string) => {
        const key = norm(p);
        if (!(key in files)) throw new Error("ENOENT");
        return files[key];
      },
    };
  }

  const cwdEditionFile = path
    .join(process.cwd(), "build", "edition", "edition-runtime.json")
    .replace(/\\/g, "/");

  it("prefers packaged resources over the app tree", () => {
    const fs = fsFrom({
      "res/edition/edition-runtime.json": JSON.stringify(VALID_INTERNAL),
      "app/build/edition/edition-runtime.json": JSON.stringify(OPEN_EDITION_DEFAULT),
    });
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config.profile).toBe("internal");
  });

  it("falls back to the app tree when resources have no edition", () => {
    const fs = fsFrom({
      "app/build/edition/edition-runtime.json": JSON.stringify(VALID_INTERNAL),
    });
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config.profile).toBe("internal");
  });

  it("returns the open default when nothing exists", () => {
    const fs = fsFrom({});
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config).toEqual(OPEN_EDITION_DEFAULT);
  });

  it("falls back to the open default on malformed edition files", () => {
    const fs = fsFrom({ "res/edition/edition-runtime.json": "{not json" });
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config).toEqual(OPEN_EDITION_DEFAULT);
  });

  it("falls back to the open default when the overlay is invalid", () => {
    const fs = fsFrom({
      "res/edition/edition-runtime.json": JSON.stringify({
        ...VALID_INTERNAL,
        profile: "bogus",
      }),
    });
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config).toEqual(OPEN_EDITION_DEFAULT);
  });

  it("falls back to the open default when an additional preset collides with a built-in id", () => {
    const fs = fsFrom({
      "res/edition/edition-runtime.json": JSON.stringify({
        ...VALID_INTERNAL,
        providerPresets: [{ ...VALID_INTERNAL.providerPresets[0], id: "qq" }],
      }),
    });
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config).toEqual(OPEN_EDITION_DEFAULT);
  });

  it("falls back to the open default when the first existing file is corrupt, even if a lower-priority copy is valid", () => {
    const fs = fsFrom({
      "res/edition/edition-runtime.json": "{not json",
      "app/build/edition/edition-runtime.json": JSON.stringify(VALID_INTERNAL),
    });
    const config = loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read });
    expect(config).toEqual(OPEN_EDITION_DEFAULT);
  });

  it("ignores the cwd candidate unless devFallback is enabled", () => {
    const fs = fsFrom({ [cwdEditionFile]: JSON.stringify(VALID_INTERNAL) });
    expect(
      loadEditionRuntimeConfig("app", "res", { exists: fs.exists, read: fs.read }),
    ).toEqual(OPEN_EDITION_DEFAULT);
    expect(
      loadEditionRuntimeConfig("app", "res", {
        exists: fs.exists,
        read: fs.read,
        devFallback: true,
      }),
    ).toEqual(VALID_INTERNAL);
  });
});
