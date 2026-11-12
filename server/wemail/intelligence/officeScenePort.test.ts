import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_OP_OFFICE_SCENES,
  type OfficeScenePort,
} from "./officeScenePort.js";

// The open edition ships only the NO_OP port: nothing is detected, nothing
// is filtered, no scene is actionable. Editions register a real
// implementation through the composition root's `modules.officeScenes`.
test("NO_OP_OFFICE_SCENES never detects and never filters", () => {
  const port: OfficeScenePort = NO_OP_OFFICE_SCENES;
  assert.equal(port.detect("【问题超时提醒】[10080565]大表整改"), undefined);
  assert.equal(port.detect("hello"), undefined);
  assert.equal(port.isSystemMail("【问题超时提醒】[10080565]大表整改"), false);
  assert.equal(port.isSystemMail("PACE+发布单结单提醒"), false);
  assert.deepEqual(port.actionableScenes(), []);
  assert.equal(port.actionMeta("overdue"), undefined);
});
