import assert from "node:assert/strict";
import test from "node:test";
import { ReconnectPacer, type ReconnectHandle } from "./reconnectPacer.js";

interface FakeTimer extends ReconnectHandle {
  run: () => void;
  at: number;
  ran: boolean;
  cancelled: boolean;
}

function makePacer(gapMs: number) {
  // Start the clock well above 0 so the very first schedule runs immediately,
  // mirroring real Date.now() (where now - lastRunAt(0) is always large).
  let clock = 1_000;
  const timers: FakeTimer[] = [];
  const pacer = new ReconnectPacer({
    gapMs,
    now: () => clock,
    schedule: (fn, ms) => {
      const timer: FakeTimer = {
        run: () => {
          timer.ran = true;
          fn();
        },
        at: clock + ms,
        ran: false,
        cancelled: false,
      };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as FakeTimer).cancelled = true;
    },
  });
  const fireDue = () => {
    for (const t of timers) {
      if (!t.ran && !t.cancelled && t.at <= clock) t.run();
    }
  };
  return {
    pacer,
    pendingCount: () =>
      timers.filter((t) => !t.ran && !t.cancelled).length,
    advance: (ms: number) => {
      clock += ms;
      fireDue();
    },
  };
}

test("ReconnectPacer: the first reconnect runs immediately (no prior reconnect)", () => {
  const { pacer } = makePacer(100);
  let runs = 0;
  pacer.schedule(() => {
    runs += 1;
  });
  assert.equal(runs, 1);
});

test("ReconnectPacer: a reconnect within the gap is deferred until the gap elapses", () => {
  const { pacer, advance, pendingCount } = makePacer(100);
  let runs = 0;
  pacer.schedule(() => {
    runs += 1;
  }); // immediate (first)
  assert.equal(runs, 1);

  pacer.schedule(() => {
    runs += 1;
  }); // within gap → deferred
  assert.equal(runs, 1);
  assert.equal(pendingCount(), 1);

  advance(100); // gap elapses → deferred reconnect fires
  assert.equal(runs, 2);
  assert.equal(pendingCount(), 0);
});

test("ReconnectPacer: bursts coalesce into one pending reconnect", () => {
  const { pacer, advance, pendingCount } = makePacer(100);
  let runs = 0;
  pacer.schedule(() => {
    runs += 1;
  });
  // Three rapid reconnect requests while one is pending → only the pending one
  // runs; the rest are coalesced (dropped).
  pacer.schedule(() => {
    runs += 1;
  });
  pacer.schedule(() => {
    runs += 1;
  });
  pacer.schedule(() => {
    runs += 1;
  });
  assert.equal(pendingCount(), 1);
  advance(100);
  assert.equal(runs, 2); // first (immediate) + the single coalesced reconnect
});

test("ReconnectPacer: cancel drops a pending reconnect", () => {
  const { pacer, advance, pendingCount } = makePacer(100);
  let runs = 0;
  pacer.schedule(() => {
    runs += 1;
  });
  pacer.schedule(() => {
    runs += 1;
  }); // deferred
  assert.equal(pendingCount(), 1);
  pacer.cancel();
  assert.equal(pendingCount(), 0);
  advance(100);
  assert.equal(runs, 1); // only the first immediate run; deferred was cancelled
});

test("ReconnectPacer: after the gap fully elapses, the next reconnect is immediate again", () => {
  const { pacer, advance } = makePacer(100);
  let runs = 0;
  pacer.schedule(() => {
    runs += 1;
  });
  advance(200); // well past the gap
  pacer.schedule(() => {
    runs += 1;
  }); // immediate again
  assert.equal(runs, 2);
});
