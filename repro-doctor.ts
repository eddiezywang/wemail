/**
 * Standalone diagnostic entry point.
 *
 * The WeCLI-specific probe that used to live here moved with the WeCLI
 * runtime to the private edition overlay (P2.5). The open tree no longer
 * ships a CLI health checker or binary resolver, so this script just
 * reports the runtime environment it was launched with. Edition builds
 * can supply their own diagnostic through their module bundle.
 */
async function main() {
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      wecliDiagnostics: "edition-only",
    }),
  );
}
main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
