#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDesktopBuildCacheRoot } from "./desktop-build-cache.mjs";
import { assertPackagingEditionIdentity } from "./edition-identity.mjs";
import {
  assertNsisArchiveSize,
  assertNsisInstallerSize,
  assertPackagedAppSize,
  assertRuntimePackagePolicy,
  auditRuntimeDependencies,
  formatBytes,
  largestRuntimePackages,
  productionDependencyCacheKey,
  pruneRuntimeDependencies,
} from "./desktop-runtime-audit.mjs";
import { ensureElectronNativeBindings } from "./ensure-electron-native-bindings.mjs";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";
import { newestProductionMtime } from "./desktop-build-inputs.mjs";
import {
  brandWindowsExecutable,
  getDesktopExecutableName,
} from "./windows-executable-branding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "win-unpacked");
const desktopExecutableName = getDesktopExecutableName();
const exePath = path.join(outDir, desktopExecutableName);
const appDir = path.join(outDir, "resources", "app");
const layoutMarker = path.join(outDir, ".wemail-incremental-package.json");
const iconPath = path.join(root, "electron", "assets", "wemail.ico");
const certificateInstallerPath = path.join(root, "packaging", "windows", "install-wemail-certificate.cmd");
const rceditPath = path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
const skipBuild = process.argv.includes("--skip-build");

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, ...options });
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status ?? 1}`);
}
function syncDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  if (process.platform === "win32") {
    const result = spawnSync("robocopy.exe", [from, to, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/NS", "/NC", "/R:2", "/W:1"], { encoding:"utf8" });
    if ((result.status ?? 1) > 7) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`robocopy failed from ${from} to ${to}`);
    }
  } else { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true, force: true }); }
}
function newestMtime(p) {
  return newestProductionMtime(root, p);
}
function isBuildFresh() {
  const outputs = [path.join(root,"build","client","index.html"), path.join(root,"dist-electron","electron","main","app.js")];
  if (outputs.some((p)=>!fs.existsSync(p))) return false;
  const inputs = ["app","electron","server","shared","public","vite.config.ts","react-router.config.ts","tsconfig.json","tsconfig.app.json","package.json","bun.lock"].map((p)=>path.join(root,p));
  return Math.min(...outputs.map((p)=>fs.statSync(p).mtimeMs)) > Math.max(...inputs.map(newestMtime));
}
function buildIfNeeded(env) {
  if (skipBuild) {
    if (!isBuildFresh()) throw new Error("--skip-build requires fresh desktop build outputs");
    return console.log("[package] reusing explicitly verified desktop build");
  }
  if (isBuildFresh()) return console.log("[package] desktop build is fresh; skipping rebuild");
  if (process.platform === "win32") run("cmd.exe", ["/d","/s","/c","npm run build:desktop"], { env }); else run("npm", ["run","build:desktop"], { env });
}
/**
 * Pre-seed sharp + its platform native packages from the project node_modules
 * into the staging node_modules BEFORE bun install. bun then sees them as
 * already-satisfied and skips fetching/extracting them.
 *
 * Why: on Windows, bun's extraction of @img/sharp-win32-x64 (a native .node)
 * frequently fails with EPERM because Defender real-time scanning locks the
 * file during bun's temp→cache rename. Copying the already-installed project
 * copy sidesteps bun's cache entirely. Safe under --frozen-lockfile: bun only
 * skips already-present packages at the locked version; it does not refetch.
 */
function seedSharpFromProjectNodeModules(stage) {
  const stageModules = path.join(stage, "node_modules");
  const projectModules = path.join(root, "node_modules");
  const seeds = ["sharp"];
  const imgDir = path.join(projectModules, "@img");
  if (fs.existsSync(imgDir)) {
    for (const entry of fs.readdirSync(imgDir)) {
      if (entry.startsWith("sharp-")) seeds.push(path.join("@img", entry));
    }
  }
  fs.mkdirSync(stageModules, { recursive: true });
  for (const rel of seeds) {
    const src = path.join(projectModules, rel);
    const dest = path.join(stageModules, rel);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.cpSync(src, dest, { recursive: true });
      console.log(`[package] pre-seeded ${rel} from project node_modules`);
    }
  }
}

function prepareProductionDependencies(cacheRoot, env) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  const lockfile = fs.readFileSync(path.join(root,"bun.lock"));
  const hash = productionDependencyCacheKey({ dependencies:pkg.dependencies, overrides:pkg.overrides, lockfile });
  const stage = path.join(cacheRoot,"packaging","production-dependencies",hash); const marker = path.join(stage,".ready");
  if (!fs.existsSync(marker)) {
    fs.rmSync(stage,{recursive:true,force:true});
    fs.mkdirSync(stage,{recursive:true}); fs.copyFileSync(path.join(root,"package.json"),path.join(stage,"package.json")); fs.copyFileSync(path.join(root,"bun.lock"),path.join(stage,"bun.lock"));
    seedSharpFromProjectNodeModules(stage);
    run(process.platform === "win32" ? "bun.exe" : "bun", ["install","--production","--ignore-scripts","--frozen-lockfile"], { cwd:stage, env:{...env,BUN_INSTALL_CACHE_DIR:path.join(cacheRoot,"bun")} });
  } else console.log(`[package] reusing production cache: ${stage}`);
  run(process.execPath, [path.join(root,"scripts","patch-pi-skill-exports.mjs"), stage]);
  const modules = path.join(stage,"node_modules");
  pruneRuntimeDependencies(modules);
  const audit = auditRuntimeDependencies({
    entries:[path.join(root,"dist-electron","electron","main","app.js")],
    dependencies:pkg.dependencies,
    modulesDirectory:modules,
  });
  const moduleBytes = assertRuntimePackagePolicy(modules);
  console.log(`[package] runtime audit: ${audit.files.length} files, ${audit.packages.length} direct packages`);
  console.log(`[package] runtime node_modules: ${formatBytes(moduleBytes)}`);
  for (const item of largestRuntimePackages(modules)) console.log(`[package]   ${item.name}: ${formatBytes(item.bytes)}`);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker,JSON.stringify({createdAt:new Date().toISOString(),packages:audit.packages},null,2));
  return modules;
}
function verifyPdfRuntime(modules) {
  const pdfEntry=path.join(modules,"pdf-parse","dist","pdf-parse","esm","index.js");
  const fixtureEntry=path.join(root,"dist-electron","server","wemail","agent","testing","TextPdfFixture.js");
  const code=`
    import { pathToFileURL } from "node:url";
    const { PDFParse } = await import(pathToFileURL(${JSON.stringify(pdfEntry)}).href);
    const { buildTextPdf } = await import(pathToFileURL(${JSON.stringify(fixtureEntry)}).href);
    const parser = new PDFParse({ data: buildTextPdf(["Runtime PDF smoke test"]) });
    try {
      const result = await parser.getText();
      if (!result.text.includes("Runtime PDF smoke test")) throw new Error("PDF text was not extracted");
    } finally {
      await parser.destroy();
    }
  `;
  const result=spawnSync(process.execPath,["--input-type=module","--eval",code],{cwd:root,encoding:"utf8"});
  if(result.status!==0) throw new Error(`Packaged pdf-parse smoke test failed: ${(result.stderr||result.stdout||"").trim()}`);
  console.log("[package] pdf-parse runtime smoke passed");
}
function initializeRuntime(runtime) {
  let current; try { current=JSON.parse(fs.readFileSync(layoutMarker,"utf8")); } catch { /* initialize */ }
  if (current?.electronVersion!==runtime.version || !fs.existsSync(exePath)) {
    fs.rmSync(outDir,{recursive:true,force:true}); syncDirectory(runtime.runtimePath,outDir); fs.renameSync(path.join(outDir,"electron.exe"),exePath); fs.writeFileSync(layoutMarker,JSON.stringify({electronVersion:runtime.version}));
  }
  const branding = brandWindowsExecutable({ executablePath:exePath, iconPath, internalName:"WeMailDesktop", originalFilename:desktopExecutableName, rceditPath });
  console.log(`[package] executable branding ${branding.branded ? "updated" : "ready"}`);
}
function syncApplication(modules,native) {
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")); fs.mkdirSync(appDir,{recursive:true});
  // Keep the root package-scope imports map in resources/app/package.json.
  // An open cold build does NOT emit dist-electron/package.json, so the app
  // root is the only package scope that can bind "#edition-modules" to the
  // committed NO_OP stub; dropping it makes the packaged app fail at boot
  // with ERR_PACKAGE_IMPORT_NOT_DEFINED. Edition builds may add a nearer
  // dist-electron/package.json, but this root binding must still be valid.
  const appManifest={name:pkg.name,version:pkg.version,private:true,type:"module",main:pkg.main,dependencies:pkg.dependencies};
  if (pkg.imports) appManifest.imports=pkg.imports;
  fs.writeFileSync(path.join(appDir,"package.json"),JSON.stringify(appManifest,null,2));
  for (const rel of ["build","dist-electron","public"]) syncDirectory(path.join(root,rel),path.join(appDir,rel));
  syncDirectory(modules,path.join(appDir,"node_modules"));
  // extraResources (electron/assets, skills/builtin, automation-templates/builtin)
  // ship beside the asar so runtime seeding can read them via process.resourcesPath.
  for (const entry of pkg.build?.extraResources ?? []) {
    const from = typeof entry === "string" ? entry : entry.from;
    const to = typeof entry === "string" ? entry : entry.to;
    const src = path.join(root, from);
    if (!fs.existsSync(src)) throw new Error(`extraResources source missing: ${from}`);
    const dest = path.join(outDir, "resources", to);
    if (fs.statSync(src).isDirectory()) syncDirectory(src, dest);
    else { fs.rmSync(dest, { recursive:true, force:true }); fs.mkdirSync(path.dirname(dest), { recursive:true }); fs.copyFileSync(src, dest); }
  }
  fs.copyFileSync(certificateInstallerPath,path.join(outDir,"install-wemail-certificate.cmd"));
  const target=path.join(appDir,"node_modules","better-sqlite3","build","Release","better_sqlite3.node"); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(native.cachePath,target);
}
function verify() {
  for (const p of [exePath,path.join(outDir,"install-wemail-certificate.cmd"),path.join(appDir,"build","client","index.html"),path.join(appDir,"dist-electron","electron","main","app.js"),path.join(appDir,"node_modules","better-sqlite3","build","Release","better_sqlite3.node")]) if (!fs.existsSync(p)) throw new Error(`missing packaged file: ${p}`);
  for (const name of ["electron","electron-builder"]) if (fs.existsSync(path.join(appDir,"node_modules",name))) throw new Error(`desktop tool leaked: ${name}`);
  for (const rel of ["skills/builtin","automation-templates/builtin"]) { const p=path.join(outDir,"resources",rel); if (!fs.existsSync(p) || fs.readdirSync(p).length===0) throw new Error(`missing packaged extraResource: ${rel}`); }
  // Packaging contract: every package scope that binds "#edition-modules"
  // must ship the file it points at. The app root binding covers the open
  // NO_OP stub; an edition build may add the nearer dist-electron scope.
  const assertImportTarget=(manifestPath)=>{
    const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
    const binding=manifest.imports?.["#edition-modules"];
    if (typeof binding!=="string") throw new Error(`missing #edition-modules binding in ${manifestPath}`);
    const target=path.resolve(path.dirname(manifestPath),binding.split(/[?#]/,1)[0]);
    if (!fs.existsSync(target)) throw new Error(`#edition-modules target is not packaged: ${target}`);
    console.log(`[package] #edition-modules bound by ${path.relative(outDir,manifestPath)} -> ${path.relative(appDir,target)}`);
  };
  assertImportTarget(path.join(appDir,"package.json"));
  const nearerManifest=path.join(appDir,"dist-electron","package.json");
  if (fs.existsSync(nearerManifest)) assertImportTarget(nearerManifest);
  const moduleBytes=assertRuntimePackagePolicy(path.join(appDir,"node_modules"));
  const appBytes=assertPackagedAppSize(appDir);
  console.log(`[package] packaged app: ${formatBytes(appBytes)} (node_modules ${formatBytes(moduleBytes)})`);
}
const delay=(ms)=>new Promise((r)=>setTimeout(r,ms));
async function smoke() { if (process.platform!=="win32") return; const child=spawn(exePath,[],{cwd:outDir,stdio:"ignore"}); let exited=false; child.once("exit",()=>{exited=true;}); await delay(5000); if(exited) throw new Error("packaged app exited early"); spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore"}); }
function environment(cacheRoot) { const temp=path.join(cacheRoot,"temp","packaging"); fs.mkdirSync(temp,{recursive:true}); return {...process.env,TEMP:temp,TMP:temp,ELECTRON_BUILDER_CACHE:path.join(cacheRoot,"electron-builder"),ELECTRON_BUILDER_BINARIES_MIRROR:process.env.ELECTRON_BUILDER_BINARIES_MIRROR||"https://npmmirror.com/mirrors/electron-builder-binaries/"}; }
function verifyEditionIdentity() {
  // Edition guard (both directions): the build being packaged must carry an
  // identity record matching the edition the current environment selects —
  // otherwise an internal build could be reused for an open package or vice
  // versa. Runs before any heavy packaging work when the build is reused,
  // and again after an automatic rebuild regenerated the record.
  const identity = assertPackagingEditionIdentity({ root });
  console.log(`[package] edition identity verified: profile=${identity.profile}, overlay=${identity.overlay === "open-default" ? "open-default" : `sha256:${identity.overlay.slice(0, 12)}`}`);
}
async function packageDir() { const cacheRoot=ensureDesktopBuildCacheRoot({root}); const env=environment(cacheRoot);
  const reuseCachedBuild = skipBuild || isBuildFresh();
  if (reuseCachedBuild) verifyEditionIdentity();
  const runtime=await ensureElectronRuntime({root}); const native=ensureElectronNativeBindings({root}); buildIfNeeded(env);
  if (!reuseCachedBuild) verifyEditionIdentity();
  const modules=prepareProductionDependencies(cacheRoot,env); verifyPdfRuntime(modules); initializeRuntime(runtime); syncApplication(modules,native); verify(); await smoke(); console.log(`[package] ready: ${exePath}`); }
function removeFileWithRetries(filePath) {
  for (let attempt=0; attempt<6; attempt+=1) {
    try { fs.rmSync(filePath,{force:true}); return; }
    catch (error) {
      if (attempt===5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
    }
  }
}
function installer() {
  if(!fs.existsSync(exePath)) throw new Error("Run package:desktop:dir first");
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  const artifactName = `WeMail-${pkg.version}-x64`;
  const installerPath=path.join(root,"dist",`${artifactName}.exe`);
  const blockMapPath=`${installerPath}.blockmap`;
  assertRuntimePackagePolicy(path.join(appDir,"node_modules"));
  assertPackagedAppSize(appDir);
  const cacheRoot=ensureDesktopBuildCacheRoot({root});
  const temporaryOutput=path.join(cacheRoot,"packaging","nsis-output",`${pkg.version}-${process.pid}-${Date.now()}`);
  const temporaryArchive=path.join(temporaryOutput,`${pkg.name}-${pkg.version}-x64.nsis.7z`);
  const temporaryInstaller=path.join(temporaryOutput,`${artifactName}.exe`);
  const temporaryBlockMap=`${temporaryInstaller}.blockmap`;
  fs.mkdirSync(temporaryOutput,{recursive:true});
  for (const artifact of [installerPath,blockMapPath]) removeFileWithRetries(artifact);
  const args=["node_modules/electron-builder/cli.js","--win","nsis","--x64","--publish=never",`--prepackaged=${outDir}`,`--config.directories.output=${temporaryOutput}`];
  console.log(`\n> ${process.execPath} ${args.join(" ")}`);
  const result=spawnSync(process.execPath,args,{cwd:root,env:environment(cacheRoot),encoding:"utf8",maxBuffer:50*1024*1024});
  if(result.stdout) process.stdout.write(result.stdout);
  if(result.stderr) process.stderr.write(result.stderr);
  if(result.status!==0) {
    const output=`${result.stdout??""}\n${result.stderr??""}`;
    const cleanupBusy=/EBUSY:[\s\S]*unlink[\s\S]*\.nsis\.7z/i.test(output);
    const completedArtifacts=fs.existsSync(temporaryInstaller) && fs.statSync(temporaryInstaller).size>0 && fs.existsSync(temporaryBlockMap) && fs.statSync(temporaryBlockMap).size>0;
    if(!cleanupBusy || !completedArtifacts) throw new Error(`${process.execPath} failed with exit ${result.status??1}`);
    assertNsisArchiveSize(temporaryArchive);
    console.warn("[package] electron-builder completed the installer but Windows briefly locked its temporary NSIS archive; accepting verified artifacts");
    removeFileWithRetries(temporaryArchive);
  }
  const installerBytes=assertNsisInstallerSize(temporaryInstaller);
  if(!fs.existsSync(temporaryBlockMap) || fs.statSync(temporaryBlockMap).size===0) throw new Error(`Installer blockmap is missing or empty: ${temporaryBlockMap}`);
  fs.copyFileSync(temporaryInstaller,installerPath);
  fs.copyFileSync(temporaryBlockMap,blockMapPath);
  fs.rmSync(temporaryOutput,{recursive:true,force:true});
  console.log(`[package] installer ready: ${installerPath} (${formatBytes(installerBytes)})`);
}
try { if(process.argv.includes("--installer-only")) installer(); else await packageDir(); } catch(error) { console.error(`[package] failed: ${error.message}`); process.exit(1); }
