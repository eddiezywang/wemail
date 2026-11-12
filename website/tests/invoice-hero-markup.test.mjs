import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

function extractCssBlock(css, marker) {
  const markerIndex = css.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing CSS marker: ${marker}`);
  const openingBrace = css.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(openingBrace + 1, index);
  }
  assert.fail(`Unclosed CSS block: ${marker}`);
}

test("invoice hero opening figure preserves the controller contract", async () => {
  const component = await readFile(
    path.join(projectRoot, "src", "components", "landing", "InvoiceHeroDemo.astro"),
    "utf8",
  );
  const openingFigure = component.match(/<figure\b[\s\S]*?>/)?.[0] ?? "";
  assert.match(openingFigure, /\bdata-invoice-hero(?:\s|>)/);
  assert.match(openingFigure, /\bdata-animation-state="complete"/);
  assert.doesNotMatch(openingFigure, /\bdata-replay-key=/);
});

test("invoice hero contains the real app regions and confirmation flow", async () => {
  const component = await readFile(
    path.join(projectRoot, "src", "components", "landing", "InvoiceHeroDemo.astro"),
    "utf8",
  );
  assert.match(component, /data-invoice-hero/);
  assert.match(component, /data-invoice-hero-viewport/);
  assert.doesNotMatch(component, /data-invoice-hero-replay|重新播放/);
  assert.match(component, /WeMail AI/);
  assert.match(component, /读取邮件/);
  assert.match(component, /处理附件/);
  assert.match(component, /需要确认/);
  assert.match(component, /上传 1 个 PDF 发票附件到发票平台/);
  assert.match(component, /上传完成：成功 1 个，失败 0 个/);
  assert.doesNotMatch(component, /@example\.com|26427000000575120566/);
});

test("invoice hero renders no animation playback controls", async () => {
  const component = await readFile(
    path.join(projectRoot, "src", "components", "landing", "InvoiceHeroDemo.astro"),
    "utf8",
  );
  assert.doesNotMatch(component, /<button\b[^>]*data-invoice-hero-replay/);
  assert.doesNotMatch(component, /data-replay-key|重新播放/);
});

test("invoice hero viewport keeps faux confirmation controls non-interactive", async () => {
  const component = await readFile(
    path.join(projectRoot, "src", "components", "landing", "InvoiceHeroDemo.astro"),
    "utf8",
  );
  const viewportStart = component.indexOf("data-invoice-hero-viewport");
  const viewportEnd = component.indexOf("</figure>", viewportStart);
  assert.notEqual(viewportStart, -1);
  assert.notEqual(viewportEnd, -1);
  const viewportMarkup = component.slice(viewportStart, viewportEnd);
  assert.doesNotMatch(viewportMarkup, /<button\b/);
  assert.match(viewportMarkup, />拒绝</);
  assert.match(viewportMarkup, />确认</);
});

test("invoice hero CSS defines desktop, paused, completed, narrow, and reduced-motion states", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "invoice-hero.css"),
    "utf8",
  );
  assert.match(css, /grid-template-columns:\s*12fr 21fr 38fr 29fr/);
  assert.match(css, /\[data-animation-state="paused"\]/);
  assert.match(css, /\[data-animation-state="complete"\]/);
  assert.match(css, /@media \(max-width: 62rem\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-play-state:\s*paused/);
  assert.match(css, /\.invoice-hero__viewport\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(css, /@media \(max-width: 62rem\)[\s\S]*\.invoice-hero__viewport\s*\{[^}]*aspect-ratio:\s*auto/s);
  assert.match(css, /\.invoice-hero__eyebrow[\s\S]*font-size:\s*1rem/);
  assert.match(css, /\[data-animation-state="playing"\]\s+\.invoice-hero__prompt/);
  assert.match(css, /\[data-animation-state="paused"\]\s+\.invoice-hero__prompt/);
  assert.doesNotMatch(css, /data-invoice-hero-replay|\.is-replaying/);
});

test("invoice hero workspace fills the 16:9 viewport below the titlebar", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "invoice-hero.css"),
    "utf8",
  );
  const viewportRules = extractCssBlock(css, ".invoice-hero__viewport");
  const workspaceRules = extractCssBlock(css, ".invoice-hero__workspace");

  assert.match(viewportRules, /display:\s*grid/);
  assert.match(
    viewportRules,
    /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/,
  );
  assert.match(workspaceRules, /min-height:\s*0/);
  assert.doesNotMatch(workspaceRules, /min-height:\s*31\.4rem/);
});

test("security callout secondary button sets a dark foreground color", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "landing.css"),
    "utf8",
  );
  assert.match(
    css,
    /\.security-callout \.button--secondary\s*\{[^}]*color:\s*#2d2825;/s,
  );
});

test("feature demo CSS drops the deleted action-loop selectors and retains documentation demo steps", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "feature-demos.css"),
    "utf8",
  );
  assert.doesNotMatch(css, /\.demo-action-grid/);
  assert.match(css, /\.demo-steps li\s*{/);
  assert.match(css, /\.demo-steps strong,\s*\n\.demo-steps small\s*{/);
  assert.match(css, /\.demo-steps small\s*{/);
});

test("invoice hero animation uses a 12-second loop with a readable success plateau", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "invoice-hero.css"),
    "utf8",
  );
  const timedScenes = css.match(
    /animation:\s*invoice-(?:prompt|analysis|confirmation|pointer|success) 12s/g,
  ) ?? [];
  assert.equal(timedScenes.length, 5);
  const successFrames = extractCssBlock(css, "@keyframes invoice-success");
  assert.match(successFrames, /74%,\s*96%\s*{\s*opacity:\s*1;/);
  assert.match(successFrames, /100%\s*{\s*opacity:\s*0;/);
});

test("invoice hero narrow layout exposes the static success state", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "invoice-hero.css"),
    "utf8",
  );
  const narrowRules = extractCssBlock(css, "@media (max-width: 62rem)");
  assert.match(
    narrowRules,
    /\.invoice-hero__success\s*{[^}]*opacity:\s*1\s*!important;[^}]*transform:\s*none\s*!important;/s,
  );
});
