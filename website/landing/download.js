export async function getDownloadTarget(browser) {
  const ua = browser.userAgent ?? "";
  const hints = browser.userAgentData;
  const platformHint = hints?.platform?.toLowerCase();
  const ipadDesktop = browser.platform === "MacIntel" && browser.maxTouchPoints > 1;
  if (hints?.mobile || ipadDesktop || /Android|iPhone|iPad|iPod|Windows Phone/i.test(ua)) {
    return { mobile: true };
  }

  const platform = platformHint ||
    (/Windows NT/i.test(ua) ? "windows" : /Macintosh/i.test(ua) ? "macos" : "");
  if (platform !== "windows" && platform !== "macos") return {};

  // Safari can identify as Intel on Apple Silicon, and emulated Windows
  // browsers can send an x64 user agent on ARM. Only trust explicit ARM
  // markers in legacy user agents. Use client hints for x64.
  const legacyArch = /\b(?:arm64|aarch64)\b/i.test(ua) ? "arm64" : undefined;
  try {
    const info = await hints?.getHighEntropyValues?.(["architecture", "bitness"]);
    if (info?.architecture === "arm" && info.bitness === "64") return { platform, arch: "arm64" };
    if (info?.architecture === "x86" && info.bitness === "64") return { platform, arch: "x64" };
    if (info?.architecture || info?.bitness) return { platform };
  } catch {
    // Some browsers or browser policies withhold architecture information.
  }
  return { platform, arch: legacyArch };
}

export async function showRecommendedDownload(browser, page) {
  const feedback = page.querySelector("#download-device");
  const options = page.querySelector(".download-options");
  const { platform, arch, mobile } = await getDownloadTarget(browser);
  if (mobile) {
    feedback.textContent = "请在 Windows 或 macOS 电脑上安装 WeMail。";
    return;
  }
  if (!platform) return;

  const group = options.querySelector(`[data-platform="${platform}"]`);
  const platformName = platform === "windows" ? "Windows" : "macOS";
  const asset = arch && group.querySelector(`[data-arch="${arch}"]`);
  if (!asset) {
    group.parentElement.prepend(group);
    feedback.textContent = `检测到 ${platformName}，请选择处理器版本。`;
    return;
  }

  const targetName = {
    windows: { x64: "Windows x64", arm64: "Windows ARM64" },
    macos: { x64: "Mac（Intel）", arm64: "Mac（Apple Silicon）" },
  }[platform][arch];
  const primary = page.createElement("a");
  primary.className = "download-link recommended";
  primary.href = asset.href;
  primary.textContent = `↓ 下载 ${targetName}`;
  const recommendation = page.querySelector("#download-recommendation");
  recommendation.append(primary);
  recommendation.hidden = false;
  if (!options.contains(page.activeElement)) options.open = false;
}

if (typeof document !== "undefined") {
  void showRecommendedDownload(navigator, document);
}
