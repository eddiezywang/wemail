const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 3_000];

function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function signAfterPack(
  context,
  {
    platform = process.platform,
    env = process.env,
    exec = execFileSync,
    brand,
    sleep = wait,
  } = {},
) {
  if (platform !== "win32") return;

  // The target platform can be injected by packaging contract tests running
  // on another OS. Windows output paths must still use Windows semantics.
  const targetPath = path.win32;

  if (env.WEMAIL_SELF_SIGN_AFTER_PACK !== "1") return;

  const thumbprint = env.WEMAIL_SIGNING_THUMBPRINT;
  if (!thumbprint) {
    throw new Error("WEMAIL_SIGNING_THUMBPRINT is required for self-signed packaging.");
  }

  const executable = targetPath.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const rceditPath = env.WEMAIL_RCEDIT_PATH;
  if (!rceditPath) {
    throw new Error("WEMAIL_RCEDIT_PATH is required for self-signed packaging.");
  }

  const projectDir = context.packager.projectDir;
  const brandExecutable =
    brand ??
    (
      await import(
        pathToFileURL(
          path.join(projectDir, "scripts", "windows-executable-branding.mjs"),
        ).href
      )
    ).brandWindowsExecutable;
  const brandingOptions = {
    executablePath: executable,
    iconPath: targetPath.join(projectDir, "packaging", "icon.ico"),
    originalFilename: targetPath.basename(executable),
    version: context.packager.appInfo.version,
    markerPath: targetPath.join(context.outDir, ".wemail-executable-branding.json"),
    platform,
    rceditPath,
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      brandExecutable(brandingOptions);
      break;
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  exec(
    "signtool.exe",
    ["sign", "/sha1", thumbprint, "/s", "My", "/fd", "SHA256", executable],
    { stdio: "inherit" },
  );
}

exports.default = signAfterPack;
exports.signAfterPack = signAfterPack;
