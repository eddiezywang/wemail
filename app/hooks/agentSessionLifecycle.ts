export type AgentSessionMode =
  | "home-fresh"
  | "email-trace"
  | "history-resume";

export type AgentSessionNavigation = {
  agentSessionMode: AgentSessionMode;
  agentSessionId: string;
};

export type AgentSessionIdFactory = () => string;

function makeAgentSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `conv-${crypto.randomUUID()}`;
  }
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createFreshHomeAgentSession(
  makeId: AgentSessionIdFactory = makeAgentSessionId,
): AgentSessionNavigation {
  return {
    agentSessionMode: "home-fresh",
    agentSessionId: makeId(),
  };
}

export function openEmailAgentSession(
  emailId: string,
): AgentSessionNavigation {
  return {
    agentSessionMode: "email-trace",
    agentSessionId: emailId,
  };
}

export function resumeAgentSession(
  conversationId: string,
): AgentSessionNavigation {
  return {
    agentSessionMode: "history-resume",
    agentSessionId: conversationId,
  };
}
