import assert from "node:assert/strict";
import test from "node:test";
import { FeishuStreamCircuitBreaker } from "./feishuStreamCircuitBreaker.js";

function breaker(now: () => number) {
  return new FeishuStreamCircuitBreaker(2, 10 * 60_000, now);
}

test("circuit breaker: allows until the failure threshold is reached", () => {
  let t = 1000;
  const b = breaker(() => t);
  assert.equal(b.allow("p1"), true);
  b.recordFailure("p1");
  assert.equal(b.allow("p1"), true, "one failure does not trip");
  b.recordFailure("p1");
  assert.equal(b.allow("p1"), false, "two consecutive failures trip");
});

test("circuit breaker: success resets the failure count", () => {
  let t = 1000;
  const b = breaker(() => t);
  b.recordFailure("p1");
  b.recordSuccess("p1");
  b.recordFailure("p1");
  assert.equal(b.allow("p1"), true, "count reset by success, so one failure does not trip");
});

test("circuit breaker: tripped profile re-allows after the cooldown elapses", () => {
  let t = 1000;
  const b = breaker(() => t);
  b.recordFailure("p1");
  b.recordFailure("p1");
  assert.equal(b.allow("p1"), false);
  t += 10 * 60_000 + 1; // past cooldown
  assert.equal(b.allow("p1"), true, "re-allows after cooldown");
});

test("circuit breaker: profiles are independent", () => {
  let t = 1000;
  const b = breaker(() => t);
  b.recordFailure("p1");
  b.recordFailure("p1");
  assert.equal(b.allow("p1"), false);
  assert.equal(b.allow("p2"), true, "p2 unaffected by p1's failures");
});
