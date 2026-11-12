import { describe, expect, it } from "vitest";
import {
  createFreshHomeAgentSession,
  openEmailAgentSession,
  resumeAgentSession,
} from "~/hooks/agentSessionLifecycle";

describe("agentSessionLifecycle", () => {
  it("creates a distinct runtime-only home conversation on every entry", () => {
    const ids = ["conv-home-1", "conv-home-2"];
    const makeId = () => ids.shift()!;

    expect(createFreshHomeAgentSession(makeId)).toEqual({
      agentSessionMode: "home-fresh",
      agentSessionId: "conv-home-1",
    });
    expect(createFreshHomeAgentSession(makeId)).toEqual({
      agentSessionMode: "home-fresh",
      agentSessionId: "conv-home-2",
    });
  });

  it("uses the selected mail id for trace history", () => {
    expect(openEmailAgentSession("msg-1")).toEqual({
      agentSessionMode: "email-trace",
      agentSessionId: "msg-1",
    });
  });

  it("restores an explicitly selected conversation", () => {
    expect(resumeAgentSession("conv-history-1")).toEqual({
      agentSessionMode: "history-resume",
      agentSessionId: "conv-history-1",
    });
  });
});
