import assert from "node:assert/strict";
import test from "node:test";
import { AiNetworkCircuitBreaker } from "./AiNetworkCircuitBreaker.js";

test("AI network circuit opens, permits one half-open probe, and closes after success", () => {
  let now = 1_000;
  const circuit = new AiNetworkCircuitBreaker({
    failureThreshold: 2,
    openDurationMs: 5_000,
    now: () => now,
  });

  assert.equal(circuit.tryAcquire(), true);
  circuit.recordFailure(Object.assign(new Error("network-error"), { code: "NETWORK" }));
  assert.equal(circuit.health().state, "closed");

  assert.equal(circuit.tryAcquire(), true);
  circuit.recordFailure(new Error("unexpected EOF"));
  assert.deepEqual(circuit.health(), {
    state: "open",
    consecutiveFailures: 2,
    nextProbeAt: 6_000,
  });
  assert.equal(circuit.tryAcquire(), false);

  now = 6_000;
  assert.equal(circuit.tryAcquire(), true);
  assert.equal(circuit.health().state, "half-open");
  assert.equal(circuit.tryAcquire(), false);
  circuit.recordSuccess();
  assert.deepEqual(circuit.health(), {
    state: "closed",
    consecutiveFailures: 0,
    nextProbeAt: null,
  });
});

test("non-network failures do not trip the AI network circuit", () => {
  const circuit = new AiNetworkCircuitBreaker({ failureThreshold: 1 });
  assert.equal(circuit.tryAcquire(), true);
  circuit.recordFailure(Object.assign(new Error("invalid response"), { code: "PARSE" }));
  assert.equal(circuit.health().state, "closed");
  assert.equal(circuit.health().consecutiveFailures, 0);
});

test("HTTP model failures trip the circuit and increase the probe interval", () => {
  let now = 0;
  const circuit = new AiNetworkCircuitBreaker({
    failureThreshold: 1,
    openDurationMs: 1_000,
    maxOpenDurationMs: 4_000,
    now: () => now,
  });

  circuit.tryAcquire();
  circuit.recordFailure({ status: 503 });
  assert.equal(circuit.health().nextProbeAt, 1_000);

  now = 1_000;
  assert.equal(circuit.tryAcquire(), true);
  circuit.recordFailure({ status: 429 });
  assert.equal(circuit.health().nextProbeAt, 3_000);

  now = 3_000;
  assert.equal(circuit.tryAcquire(), true);
  circuit.recordFailure({ status: 503 });
  assert.equal(circuit.health().nextProbeAt, 7_000);
});
