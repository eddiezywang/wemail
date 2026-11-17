import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  demoPhase,
  initialDemoState,
  reduceDemoState,
  supportsFeatureDemoEnhancement,
} from "../src/scripts/feature-demo.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("plays only while visible", () => {
  let state = initialDemoState(false);
  assert.deepEqual(state, {
    visible: false,
    reducedMotion: false,
  });
  assert.equal(demoPhase(state), "paused");
  state = reduceDemoState(state, { type: "VISIBILITY", visible: true });
  assert.equal(demoPhase(state), "playing");
  state = reduceDemoState(state, { type: "VISIBILITY", visible: false });
  assert.equal(demoPhase(state), "paused");
});

test("reduced motion always presents the completed state", () => {
  let state = initialDemoState(true);
  state = reduceDemoState(state, { type: "VISIBILITY", visible: true });
  assert.equal(demoPhase(state), "complete");
});

test("keeps the static completed state when required browser APIs are unavailable", () => {
  assert.equal(supportsFeatureDemoEnhancement({}), false);
  assert.equal(supportsFeatureDemoEnhancement({ matchMedia() {} }), false);
  assert.equal(supportsFeatureDemoEnhancement({ IntersectionObserver() {} }), false);
  assert.equal(supportsFeatureDemoEnhancement({
    matchMedia() {},
    IntersectionObserver() {},
  }), true);
});

test("feature demo component renders no playback controls", async () => {
  const component = await readFile(
    path.join(projectRoot, "src", "components", "demos", "FeatureDemo.astro"),
    "utf8",
  );
  assert.doesNotMatch(
    component,
    /feature-demo__controls|data-demo-pause|data-demo-pause-label|data-demo-replay|动画控制|重播/,
  );
});

test("feature demo controller has no manual pause or replay machinery", async () => {
  const script = await readFile(
    path.join(projectRoot, "src", "scripts", "feature-demo.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    script,
    /manualPaused|replayKey|TOGGLE_PAUSE|REPLAY|data-demo-pause|data-demo-replay|is-replaying|offsetWidth/,
  );
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /REDUCED_MOTION/);
});

test("feature demo CSS autoloops without control or replay selectors", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "feature-demos.css"),
    "utf8",
  );
  assert.match(
    css,
    /\[data-demo-state="playing"\]\s+\[data-scene-step\]\s*\{[^}]*animation:\s*demo-step 6s ease-in-out infinite both;/s,
  );
  assert.doesNotMatch(
    css,
    /feature-demo__controls|data-demo-enhanced|is-replaying/,
  );
});
