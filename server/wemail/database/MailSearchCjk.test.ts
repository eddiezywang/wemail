import assert from "node:assert/strict";
import test from "node:test";
import { cjkSearchTerms, containsHan } from "./MailSearchCjk.js";

test("Chinese search terms preserve character order and word boundaries", () => {
  assert.equal(cjkSearchTerms("AI项目进度"), "u61 u69 u9879 u76ee u8fdb u5ea6");
  assert.equal(cjkSearchTerms("项目 / 进度"), "u9879 u76ee ub u8fdb u5ea6");
  assert.equal(cjkSearchTerms("english only"), "");
  assert.equal(containsHan("项目 status"), true);
});
