// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Edition configuration — the seam between the open-source baseline and
 * edition overlays (e.g. a private internal build).
 *
 * The open-source build ships `OPEN_EDITION_DEFAULT`: no extra provider
 * presets, picker-first onboarding, no signature brand link, no enterprise
 * directory, no internal module features. An edition build generates
 * `build/edition/edition-runtime.json` from a validated overlay
 * (scripts/write-edition-config.mjs); the desktop main process loads it at
 * startup and the composition root assembles it.
 *
 * The renderer only ever sees `PublicEditionInfo` (served by
 * GET /api/system/edition) — never the full runtime config. The validator
 * below constructs every object field-by-field, so unknown keys in a runtime
 * file (top-level or nested inside a preset/endpoint) are dropped before the
 * config can reach the renderer or a generated file.
 */
import fs from "node:fs";
import path from "node:path";
import { PROVIDER_PRESETS, type ProviderPreset } from "./providers.js";

export interface EditionOnboardingConfig {
  /** Preset to pre-select when booting straight to the credentials step. */
  preferredPresetId?: string;
  /** Boot directly into credentials for the preferred preset (internal-style
   *  first-run). Open edition keeps the provider picker as step one. */
  bootToCredentials: boolean;
}

export interface EditionSignatureConfig {
  /** Outbound signature brand link. Empty string = plain-text brand. */
  brandUrl: string;
}

export interface EditionDirectoryConfig {
  /** Accounts whose email ends with this domain get directory auto-init. */
  autoInitDomain: string;
  /** Coremail endpoint injected into the directory client factory. */
  coremailBaseUrl: string;
}

/** Internal module switches (P2 extraction seam). All keys optional; an
 *  absent key — or an absent block — means the module is not built into
 *  this edition and every consumer must treat it as off. */
export interface EditionFeatures {
  wecli?: boolean;
  allowanceInvoice?: boolean;
  enterpriseDirectory?: boolean;
  officeSceneDetection?: boolean;
}

/** Feature switches as served to the renderer: always a complete object
 *  with all four keys resolved to booleans, so consumers can branch on
 *  `features.wecli` etc. without nil handling. */
export interface PublicEditionFeatures {
  wecli: boolean;
  allowanceInvoice: boolean;
  enterpriseDirectory: boolean;
  officeSceneDetection: boolean;
}

export const OPEN_EDITION_FEATURES: PublicEditionFeatures = {
  wecli: false,
  allowanceInvoice: false,
  enterpriseDirectory: false,
  officeSceneDetection: false,
};

/** Full runtime configuration (server-side only). */
export interface EditionRuntimeConfig {
  profile: "open" | "internal";
  providerPresets: ProviderPreset[];
  onboarding: EditionOnboardingConfig;
  signature: EditionSignatureConfig;
  enterpriseDirectory?: EditionDirectoryConfig;
  features?: EditionFeatures;
}

/** Whitelist view served to the renderer. */
export interface PublicEditionInfo {
  providerPresets: ProviderPreset[];
  preferredPresetId?: string;
  bootToCredentials: boolean;
  signatureBrandUrl: string;
  features: PublicEditionFeatures;
}

export const OPEN_EDITION_DEFAULT: EditionRuntimeConfig = {
  profile: "open",
  providerPresets: [],
  onboarding: { bootToCredentials: false },
  signature: { brandUrl: "" },
};

export function toPublicEditionInfo(config: EditionRuntimeConfig): PublicEditionInfo {
  return {
    providerPresets: config.providerPresets,
    preferredPresetId: config.onboarding.preferredPresetId,
    bootToCredentials: config.onboarding.bootToCredentials,
    signatureBrandUrl: config.signature.brandUrl,
    features: {
      wecli: config.features?.wecli ?? false,
      allowanceInvoice: config.features?.allowanceInvoice ?? false,
      enterpriseDirectory: config.features?.enterpriseDirectory ?? false,
      officeSceneDetection: config.features?.officeSceneDetection ?? false,
    },
  };
}

function isSafeEditionUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const BUILT_IN_PRESET_IDS = new Set(PROVIDER_PRESETS.map((preset) => preset.id));

function parseEndpoint(
  raw: unknown,
  presetId: string,
  key: "imap" | "smtp",
): { host: string; port: number; secure: boolean } {
  if (!isRecord(raw)) {
    throw new Error(`edition provider preset ${presetId} ${key} must be an object`);
  }
  if (typeof raw.host !== "string" || raw.host.length === 0) {
    throw new Error(`edition provider preset ${presetId} ${key} requires a host`);
  }
  if (
    typeof raw.port !== "number" ||
    !Number.isInteger(raw.port) ||
    raw.port <= 0 ||
    raw.port > 65_535
  ) {
    throw new Error(`edition provider preset ${presetId} ${key} port out of range`);
  }
  if (typeof raw.secure !== "boolean") {
    throw new Error(`edition provider preset ${presetId} ${key} secure must be boolean`);
  }
  // Field-by-field construction — unknown nested keys are dropped.
  return { host: raw.host, port: raw.port, secure: raw.secure };
}

/** Validates one additional preset and reconstructs it with only the
 *  ProviderPreset contract fields. Unknown keys are dropped. */
function parsePreset(raw: unknown): ProviderPreset {
  if (!isRecord(raw)) {
    throw new Error("edition provider preset must be an object");
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("edition provider preset requires a non-empty id");
  }
  // Additional presets must never shadow a built-in preset. Checked here —
  // not only in composeApp — so a tampered runtime file is rejected by the
  // loader's validation and falls back to the open default instead of
  // blocking app startup.
  if (BUILT_IN_PRESET_IDS.has(raw.id)) {
    throw new Error(`edition provider preset id collides with a built-in preset: ${raw.id}`);
  }
  if (typeof raw.label !== "string" || raw.label.length === 0) {
    throw new Error(`edition provider preset ${raw.id} requires a non-empty label`);
  }
  if (!Array.isArray(raw.domains) || raw.domains.some((domain) => typeof domain !== "string")) {
    throw new Error(`edition provider preset ${raw.id} domains must be an array of strings`);
  }
  const preset: ProviderPreset = {
    id: raw.id,
    label: raw.label,
    domains: raw.domains.slice() as string[],
    imap: parseEndpoint(raw.imap, raw.id, "imap"),
    smtp: parseEndpoint(raw.smtp, raw.id, "smtp"),
  };
  for (const key of ["helpUrl", "helpHint"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`edition provider preset ${raw.id} ${key} must be a string`);
    }
    preset[key] = value;
  }
  return preset;
}

/** Structural validation used by both the build-time generator and the
 *  composition root (fail fast on malformed overlays). Throws on error.
 *  The returned config is rebuilt field-by-field: only the whitelisted
 *  fields survive, so unknown top-level or nested keys in the input are
 *  stripped before the config reaches the renderer or a generated file. */
export function validateEditionRuntimeConfig(config: unknown): EditionRuntimeConfig {
  if (!isRecord(config)) {
    throw new Error("edition config must be an object");
  }
  if (config.profile !== "open" && config.profile !== "internal") {
    throw new Error("edition config profile must be 'open' or 'internal'");
  }
  // Absent providerPresets means "no additional presets"; a value that is
  // explicitly provided but not an array is a shape error and must fail.
  const rawPresets = config.providerPresets;
  if (rawPresets !== undefined && !Array.isArray(rawPresets)) {
    throw new Error("edition providerPresets must be an array");
  }
  const providerPresets: ProviderPreset[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawPresets ?? []) {
    const preset = parsePreset(raw);
    if (seenIds.has(preset.id)) {
      throw new Error(`duplicate edition provider preset id: ${preset.id}`);
    }
    seenIds.add(preset.id);
    providerPresets.push(preset);
  }

  const rawOnboarding = config.onboarding;
  if (rawOnboarding !== undefined && !isRecord(rawOnboarding)) {
    throw new Error("edition onboarding must be an object");
  }
  const rawPreferredPresetId = rawOnboarding?.preferredPresetId;
  if (rawPreferredPresetId !== undefined && typeof rawPreferredPresetId !== "string") {
    throw new Error("edition onboarding.preferredPresetId must be a string");
  }
  const bootToCredentials = rawOnboarding === undefined ? false : rawOnboarding.bootToCredentials;
  if (typeof bootToCredentials !== "boolean") {
    throw new Error("edition onboarding.bootToCredentials must be boolean");
  }
  const onboarding: EditionOnboardingConfig = {
    ...(typeof rawPreferredPresetId === "string" ? { preferredPresetId: rawPreferredPresetId } : {}),
    bootToCredentials,
  };

  const rawSignature = config.signature;
  if (rawSignature !== undefined && !isRecord(rawSignature)) {
    throw new Error("edition signature must be an object");
  }
  const brandUrl = rawSignature === undefined ? "" : rawSignature.brandUrl;
  if (typeof brandUrl !== "string" || (brandUrl && !isSafeEditionUrl(brandUrl))) {
    throw new Error("edition signature.brandUrl must be empty or a safe http(s) URL");
  }
  const signature: EditionSignatureConfig = { brandUrl };

  const rawDirectory = config.enterpriseDirectory;
  if (rawDirectory !== undefined && !isRecord(rawDirectory)) {
    throw new Error("edition enterpriseDirectory must be an object");
  }
  let enterpriseDirectory: EditionDirectoryConfig | undefined;
  if (rawDirectory !== undefined) {
    const autoInitDomain = rawDirectory.autoInitDomain;
    if (typeof autoInitDomain !== "string" || !autoInitDomain.startsWith("@")) {
      throw new Error("edition enterpriseDirectory.autoInitDomain must start with '@'");
    }
    const coremailBaseUrl = rawDirectory.coremailBaseUrl;
    if (typeof coremailBaseUrl !== "string" || !isSafeEditionUrl(coremailBaseUrl)) {
      throw new Error("edition enterpriseDirectory.coremailBaseUrl must be a safe http(s) URL");
    }
    enterpriseDirectory = { autoInitDomain, coremailBaseUrl };
  }

  const rawFeatures = config.features;
  if (rawFeatures !== undefined && (!isRecord(rawFeatures) || Array.isArray(rawFeatures))) {
    throw new Error("edition features must be an object");
  }
  let features: EditionFeatures | undefined;
  if (rawFeatures !== undefined) {
    // Field-by-field construction over the four known switches: a non-boolean
    // value fails validation, unknown keys (e.g. an overlay `_comment`) are
    // dropped before the config can reach a generated file or the renderer.
    features = {};
    for (const key of [
      "wecli",
      "allowanceInvoice",
      "enterpriseDirectory",
      "officeSceneDetection",
    ] as const) {
      const value = rawFeatures[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        throw new Error(`edition features.${key} must be boolean`);
      }
      features[key] = value;
    }
  }

  return {
    profile: config.profile,
    providerPresets,
    onboarding,
    signature,
    ...(enterpriseDirectory ? { enterpriseDirectory } : {}),
    ...(features !== undefined ? { features } : {}),
  };
}

export interface LoadEditionRuntimeOptions {
  /** fs seams for tests. Defaults to the real filesystem. */
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  /** Dev only: also probe `<cwd>/build/edition/edition-runtime.json`. A
   *  packaged app must never load edition config from an arbitrary process
   *  working directory — callers pass `!app.isPackaged`. Default false. */
  devFallback?: boolean;
}

/** Runtime loader — packaged resources first, then the dev app tree; the
 *  cwd candidate is probed only with `devFallback`. Edition problems must
 *  never block app startup: a candidate that exists but fails to parse or
 *  validate falls back straight to the open default (see the catch below
 *  for why it does not keep searching). */
export function loadEditionRuntimeConfig(
  appPath: string,
  resourcesPath: string,
  options: LoadEditionRuntimeOptions = {},
): EditionRuntimeConfig {
  const exists = options.exists ?? fs.existsSync;
  const read = options.read ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const candidates = [
    path.join(resourcesPath, "edition", "edition-runtime.json"),
    path.join(appPath, "build", "edition", "edition-runtime.json"),
  ];
  if (options.devFallback) {
    candidates.push(path.join(process.cwd(), "build", "edition", "edition-runtime.json"));
  }
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    try {
      return validateEditionRuntimeConfig(JSON.parse(read(candidate)));
    } catch {
      // The highest-priority existing file is corrupt, tampered with, or
      // invalid (e.g. an additional preset id colliding with a built-in).
      // Fall back directly to the open default rather than continuing the
      // search: activating a lower-priority copy could silently boot a
      // stale config from a different edition, which violates the
      // "a damaged file must not activate the internal edition" rule.
      return OPEN_EDITION_DEFAULT;
    }
  }
  return OPEN_EDITION_DEFAULT;
}
