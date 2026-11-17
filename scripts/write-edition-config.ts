#!/usr/bin/env tsx
/**
 * 构建期版本配置生成器(P1 接缝)。
 *
 * 无 WEMAIL_EDITION_OVERLAY 时输出开源默认(无附加预设、选择器优先、无签名链接、无企业目录、无内部模块开关);
 * 内部版构建传入 overlay JSON 路径(见 wemail-int/internal/config/build-overlay.json),
 * 经 validateEditionRuntimeConfig 校验后写出 build/edition/edition-runtime.json,
 * 由桌面主进程在启动时加载(与 telemetry-config 相同的发现顺序)。
 * 校验失败(重复预设 id、非法端口/协议等)直接让构建失败。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPEN_EDITION_DEFAULT,
  validateEditionRuntimeConfig,
  type EditionRuntimeConfig,
} from "../shared/wemail/edition.js";
import { PROVIDER_PRESETS, type ProviderPreset } from "../shared/wemail/providers.js";
import {
  EDITION_IDENTITY_FILENAME,
  editionIdentityFromEnv,
} from "./edition-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlayPath = process.env.WEMAIL_EDITION_OVERLAY?.trim();
const output = path.join(root, "build", "edition", "edition-runtime.json");

interface EditionOverlay {
  profile?: string;
  providerPresets?: { add?: ProviderPreset[] };
  onboarding?: { preferredPresetId?: string; bootToCredentials?: boolean };
  signature?: { brandUrl?: string };
  enterpriseDirectory?: { autoInitDomain?: string; coremailBaseUrl?: string };
  /** Internal module switches; handed to the validator raw so unknown keys
   *  (e.g. `_comment`) are stripped and non-boolean values fail the build. */
  features?: Record<string, unknown>;
}

function buildConfig(): EditionRuntimeConfig {
  if (!overlayPath) return OPEN_EDITION_DEFAULT;
  const overlay: EditionOverlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
  if (overlay.profile !== "internal") {
    throw new Error(`[edition-config] overlay profile 必须为 internal,当前: ${overlay.profile}`);
  }
  const presets = overlay.providerPresets?.add ?? [];
  const baseIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
  for (const preset of presets) {
    if (baseIds.has(preset.id)) {
      throw new Error(`[edition-config] 附加预设 id 与内置预设冲突: ${preset.id}`);
    }
  }
  const directory = overlay.enterpriseDirectory;
  return validateEditionRuntimeConfig({
    profile: "internal",
    providerPresets: presets,
    onboarding: {
      ...(overlay.onboarding?.preferredPresetId
        ? { preferredPresetId: overlay.onboarding.preferredPresetId }
        : {}),
      bootToCredentials: overlay.onboarding?.bootToCredentials ?? false,
    },
    signature: { brandUrl: overlay.signature?.brandUrl ?? "" },
    ...(directory?.autoInitDomain && directory?.coremailBaseUrl
      ? {
          enterpriseDirectory: {
            autoInitDomain: directory.autoInitDomain,
            coremailBaseUrl: directory.coremailBaseUrl,
          },
        }
      : {}),
    ...(overlay.features ? { features: overlay.features } : {}),
  });
}

const config = buildConfig();
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(config, null, "\t")}\n`);
// Record the edition identity (profile + overlay sha256 / open-default)
// alongside the runtime config. package-desktop-win-dir.mjs recomputes the
// expected identity before reusing a cached build and refuses to package a
// build recorded for a different edition (internal ↔ open mixups).
const identity = editionIdentityFromEnv();
fs.writeFileSync(
  path.join(path.dirname(output), EDITION_IDENTITY_FILENAME),
  `${JSON.stringify(identity, null, "\t")}\n`,
);
const enabledFeatures = Object.values(config.features ?? {}).filter(Boolean).length;
console.log(
  `[edition-config] wrote ${output} (profile=${config.profile}, extraPresets=${config.providerPresets.length}, directory=${config.enterpriseDirectory ? "configured" : "none"}, features=${enabledFeatures}/4, identity=${identity.profile}/${identity.overlay})`,
);
