import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractSummaryCtaCandidates,
  formatSummaryCtaCandidates,
  restoreSelectedCtas,
} from "./SummaryCtaCandidates.js";

test("extractSummaryCtaCandidates keeps content buttons and excludes mail chrome", () => {
  const candidates = extractSummaryCtaCandidates({
    bodyHtml: [
      '<a href="https://tracking.example/click?linkType=LOGO"><img alt="Brand"></a>',
      '<a href="https://tracking.example/click?linkType=RTHP">Hotels &amp; Homes</a>',
      '<a href="https://tracking.example/click?linkType=saleTitle">Limited time price drop</a>',
      '<a href="https://tracking.example/click?linkType=saleBody">Up to 20% off</a>',
      '<a href="https://tracking.example/click?linkType=saleButton">ACTIVATE NOW</a>',
    ].join(""),
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.i, 0);
  assert.equal(candidates[0]?.t, "Limited time price drop");
  assert.equal(candidates[0]?.d, "Up to 20% off");
  assert.equal(candidates[0]?.b, "ACTIVATE NOW");
});

test("formatSummaryCtaCandidates sends compact metadata without URLs", () => {
  const candidates = extractSummaryCtaCandidates({
    bodyHtml: '<a href="https://tickets.example/42">View ticket</a>',
  });
  const prompt = formatSummaryCtaCandidates(candidates);

  assert.match(prompt, /"i":0/);
  assert.match(prompt, /"t":"View ticket"/);
  assert.doesNotMatch(prompt, /tickets\.example/);
});

test("restoreSelectedCtas maps trusted indexes and rejects invented ones", () => {
  const candidates = extractSummaryCtaCandidates({
    bodyHtml: '<a href="https://offers.example/limited">View offer</a>',
  });
  const restored = restoreSelectedCtas([
    { i: 99, l: "错误链接", c: "h" },
    { i: 0, l: "查看限时优惠", c: "h" },
    { i: 0, l: "重复", c: "m" },
  ], candidates);

  assert.deepEqual(restored, [{
    url: "https://offers.example/limited",
    label: "查看限时优惠",
    confidence: "h",
    risk: false,
    riskReasons: [],
    category: "action",
  }]);
});
