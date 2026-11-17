import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createReleaseConfig,
  type ReleaseUpdatePolicy,
} from "./update-release-config.js";

interface WriteUpdatePolicyOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  outputDirectory?: string;
}

export async function writeUpdatePolicy({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  outputDirectory = path.resolve("dist-electron", "electron"),
}: WriteUpdatePolicyOptions = {}): Promise<ReleaseUpdatePolicy> {
  const release = env.WEMAIL_RELEASE_BUILD === "1";
  let targetPlatform = platform;
  let targetArch = arch;

  if (release) {
    if (!env.WEMAIL_TARGET_PLATFORM) {
      throw new Error("WEMAIL_TARGET_PLATFORM is required for release builds");
    }
    if (!env.WEMAIL_TARGET_ARCH) {
      throw new Error("WEMAIL_TARGET_ARCH is required for release builds");
    }
    targetPlatform = env.WEMAIL_TARGET_PLATFORM as NodeJS.Platform;
    targetArch = env.WEMAIL_TARGET_ARCH;
  }

  const config = createReleaseConfig({
    release,
    baseUrl: env.WEMAIL_UPDATE_BASE_URL,
    fallbackBaseUrl: env.WEMAIL_UPDATE_FALLBACK_BASE_URL,
    platform: targetPlatform,
    arch: targetArch,
    windowsPublisherName: env.WEMAIL_WINDOWS_PUBLISHER,
    appleTeamId: env.APPLE_TEAM_ID,
  });
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(
    path.join(outputDirectory, "update-policy.json"),
    `${JSON.stringify(config.policy, null, 2)}\n`,
    "utf8",
  );
  return config.policy;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entryPoint === import.meta.url) {
  await writeUpdatePolicy();
}
