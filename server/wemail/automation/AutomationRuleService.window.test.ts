import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutomationRuleDraft } from "./AutomationRuleValidation.js";
import { resolveAutomationWindow } from "./AutomationRuleService.js";

describe("resolveAutomationWindow", () => {
  it("uses the shorter of the previous-run interval and max lookback", () => {
    const rule = {
      processing: {
        mode: "perMessage",
        scope: {
          type: "previousScheduleWindow",
          maxLookback: { amount: 24, unit: "hour" },
        },
      },
    } as AutomationRuleDraft;
    const end = "2026-08-10T09:00:00.000Z";

    assert.equal(
      resolveAutomationWindow(rule, end, "2026-08-08T09:00:00.000Z")?.start,
      "2026-08-09T09:00:00.000Z",
    );
    assert.equal(
      resolveAutomationWindow(rule, end, "2026-08-10T08:00:00.000Z")?.start,
      "2026-08-10T08:00:00.000Z",
    );
  });
});
