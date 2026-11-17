import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEditionPromptSections } from "./editionModules.js";

test("edition prompt contributions require every declared feature", () => {
  const modules = {
    featurePromptSections: [
      { requires: ["wecli" as const], sections: ["commands"] },
      { requires: ["wecli" as const, "allowanceInvoice" as const], sections: () => ["invoice"] },
      { requires: ["enterpriseDirectory" as const], sections: ["directory"] },
    ],
  };
  const wecliOnly = resolveEditionPromptSections(modules, { wecli: true });
  assert.equal(typeof wecliOnly, "function");
  assert.deepEqual(typeof wecliOnly === "function" ? wecliOnly({}) : wecliOnly, ["commands"]);
  const both = resolveEditionPromptSections(modules, { wecli: true, allowanceInvoice: true });
  assert.deepEqual(typeof both === "function" ? both({}) : both, ["commands", "invoice"]);
  assert.equal(resolveEditionPromptSections(modules, {}), undefined);
});
