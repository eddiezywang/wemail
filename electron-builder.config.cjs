const release = process.env.WEMAIL_RELEASE_BUILD === "1";
const publishUrl = process.env.WEMAIL_UPDATE_FEED_URL;
const selfSignAfterPack = process.env.WEMAIL_SELF_SIGN_AFTER_PACK === "1";
// "store" skips LZMA compression of the installer — much faster, bigger file.
// Set via package:windows:self-signed:fast; internal test builds do not need a
// small download, so the default stays "normal" for real releases.
const nsisCompression = process.env.WEMAIL_NSIS_COMPRESSION || "normal";
// Fast (store-compression) test builds get a distinct artifact name so they
// never collide with the LZMA-compressed installer of the same version.
const artifactSuffix = nsisCompression === "store" ? "-fast" : "";

module.exports = {
  compression: nsisCompression,
  appId: "com.wemail.app",
  productName: "WeMail",
  artifactName: "${productName}-${version}-${arch}" + artifactSuffix + ".${ext}",
  // The internal self-signed release owns branding/signing in afterPack and
  // signs the final installer in package-release.mjs. Keeping builder's native
  // signer disabled for this profile avoids its legacy winCodeSign download,
  // which cannot be extracted on Windows hosts without symlink privileges.
  forceCodeSigning: release && !selfSignAfterPack,
  afterPack: selfSignAfterPack ? "workspace/sign-after-pack.cjs" : undefined,
  directories: {
    output: process.env.WEMAIL_RELEASE_OUTPUT_DIR || "dist",
  },
  toolsets: {
    winCodeSign: "1.1.0",
  },
  files: [
    "dist-electron/**/*",
    "build/**/*",
    "package.json",
    "!**/*.map",
    "!**/*.test.js",
    "!**/*.test.ts",
    "!**/*.test.tsx",
    "!tests/**",
    "!openspec/**",
    "!docs/**",
    "!scripts/**",
    "!docker/**",
  ],
  extraResources: [
    { from: "licenses/third-party", to: "licenses/third-party" },
    { from: "LICENSE", to: "licenses/LICENSE" },
    { from: "THIRD_PARTY_NOTICES.md", to: "licenses/THIRD_PARTY_NOTICES.md" },
    { from: "THIRD_PARTY_LICENSES.md", to: "licenses/THIRD_PARTY_LICENSES.md" },
    { from: "electron/assets", to: "assets" },
    // Built-in resources are read by the server outside the application archive.
    { from: "skills/builtin", to: "skills/builtin" },
    { from: "automation-templates/builtin", to: "automation-templates/builtin" },
  ],
  extraFiles: [
    {
      from: "packaging/windows/install-wemail-certificate.cmd",
      to: "install-wemail-certificate.cmd",
    },
  ],
  asarUnpack: ["**/*.node"],
  publish: publishUrl
    ? [{ provider: "generic", url: publishUrl }]
    : undefined,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "packaging/icon.ico",
    signAndEditExecutable: selfSignAfterPack ? false : undefined,
    verifyUpdateCodeSignature: true,
  },
  nsis: {
    include: "packaging/nsis/install-update-trust.nsh",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    shortcutName: "WeMail",
    installerIcon: "packaging/icon.ico",
    uninstallerIcon: "packaging/icon.ico",
    installerHeaderIcon: "packaging/icon.ico",
    deleteAppDataOnUninstall: false,
  },
  mac: {
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    notarize: release,
    identity: release ? undefined : null,
  },
};
