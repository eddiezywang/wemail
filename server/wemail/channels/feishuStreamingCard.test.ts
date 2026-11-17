import assert from "node:assert/strict";
import test from "node:test";
import { buildFeishuStreamingCardJson } from "./feishuStreamingCard.js";

test("buildFeishuStreamingCardJson: serializes to a streaming JSON 2.0 card", () => {
  const raw = JSON.stringify(buildFeishuStreamingCardJson());
  const card = JSON.parse(raw) as Record<string, unknown>;

  assert.equal(card.schema, "2.0");
  const config = card.config as Record<string, unknown>;
  assert.equal(config.streaming_mode, true, "created in streaming_mode");
  assert.ok(config.streaming_config, "streaming_config present");

  const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
  const ids = elements.map((e) => e.element_id);
  assert.deepEqual(ids, ["progress", "answer"], "progress + answer markdown elements");
  for (const e of elements) {
    assert.equal(e.tag, "markdown");
    assert.equal(e.content, "");
  }
});

test("buildFeishuStreamingCardJson: data field passed to card.create is a string", () => {
  // card.create requires data.data to be a JSON string; verify the builder is
  // meant to be JSON.stringify-ed by the caller.
  const data = JSON.stringify(buildFeishuStreamingCardJson());
  assert.equal(typeof data, "string");
  assert.ok(data.includes('"streaming_mode":true'));
});
