import type { AgentTool } from "./AgentRuntime.js";
import type { ToolInput } from "./AgentTypes.js";
import {
  CLAUDE_CODE_DEFAULT_WAIT_MS,
  ClaudeCodeTaskService,
} from "./ClaudeCodeRuntime.js";

function stringValue(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(input: ToolInput, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function errorResult(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createClaudeCodeAgentTools(
  service: ClaudeCodeTaskService,
): AgentTool[] {
  const start: AgentTool = {
    name: "start_local_claude_code",
    description:
      "Delegate a code reading, review, debugging, refactoring, test, or implementation task to the locally installed Claude Code CLI. Starts a managed background print-mode task and returns immediately; use get_local_claude_code_task or wait_local_claude_code_task for progress.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Complete coding task for Claude Code, including acceptance criteria.",
        },
        cwd: {
          type: "string",
          description: "Absolute project directory. Defaults to the current WeMail process directory.",
        },
        resumeSessionId: { type: "string" },
        continueLatest: { type: "boolean" },
        forkSession: { type: "boolean" },
        model: { type: "string" },
        maxTurns: { type: "number", minimum: 1, maximum: 100 },
        maxBudgetUsd: { type: "number", minimum: 0.01, maximum: 1000 },
        hardTimeoutMs: { type: "number", minimum: 60000, maximum: 86400000 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async handler(input, context) {
      try {
        const prompt = stringValue(input, "prompt");
        if (!prompt) return { ok: false, error: "prompt-required" };
        const task = service.start({
          prompt,
          cwd: stringValue(input, "cwd"),
          resumeSessionId: stringValue(input, "resumeSessionId"),
          continueLatest: booleanValue(input, "continueLatest"),
          forkSession: booleanValue(input, "forkSession"),
          model: stringValue(input, "model"),
          maxTurns: numberValue(input, "maxTurns"),
          maxBudgetUsd: numberValue(input, "maxBudgetUsd"),
          hardTimeoutMs: numberValue(input, "hardTimeoutMs"),
          requestedBy: context.sessionId,
        });
        return {
          ok: true,
          accepted: true,
          task,
          guidance:
            "Claude Code is running in the background. Do not start a duplicate task; poll this taskId or wait for completion.",
        };
      } catch (error) {
        return errorResult(error);
      }
    },
    observe: (output) => {
      const value = output as { task?: { id?: string; status?: string } };
      return value.task
        ? `Claude Code task ${value.task.id ?? "unknown"}: ${value.task.status ?? "started"}`
        : "Claude Code task start failed";
    },
  };

  const get: AgentTool = {
    name: "get_local_claude_code_task",
    description:
      "Poll a managed local Claude Code task. Returns status, bounded new output, Claude session ID, result metadata, and the next cursor.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        cursor: { type: "number", minimum: 0 },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    async handler(input) {
      try {
        const taskId = stringValue(input, "taskId");
        if (!taskId) return { ok: false, error: "taskId-required" };
        return { ok: true, task: service.get(taskId, numberValue(input, "cursor")) };
      } catch (error) {
        return errorResult(error);
      }
    },
    observe: (output) => {
      const value = output as { task?: { id?: string; status?: string } };
      return `Claude Code task ${value.task?.id ?? "unknown"}: ${value.task?.status ?? "unknown"}`;
    },
  };

  const wait: AgentTool = {
    name: "wait_local_claude_code_task",
    description:
      "Wait up to 20 seconds for a managed local Claude Code task. A wait timeout is not a task failure; it returns while the process is still running and never kills it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        timeoutMs: {
          type: "number",
          minimum: 250,
          maximum: CLAUDE_CODE_DEFAULT_WAIT_MS,
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    async handler(input, context) {
      try {
        const taskId = stringValue(input, "taskId");
        if (!taskId) return { ok: false, error: "taskId-required" };
        return {
          ok: true,
          task: await service.wait(
            taskId,
            numberValue(input, "timeoutMs") ?? CLAUDE_CODE_DEFAULT_WAIT_MS,
            context.signal,
          ),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
    observe: (output) => {
      const value = output as { task?: { id?: string; status?: string } };
      return `Claude Code task ${value.task?.id ?? "unknown"}: ${value.task?.status ?? "unknown"}`;
    },
  };

  const cancel: AgentTool = {
    name: "cancel_local_claude_code_task",
    description:
      "Cancel a running local Claude Code task and terminate its process tree. Use only when the user asks to stop it or it has reached a hard timeout.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    async handler(input) {
      try {
        const taskId = stringValue(input, "taskId");
        if (!taskId) return { ok: false, error: "taskId-required" };
        return { ok: true, task: await service.cancel(taskId) };
      } catch (error) {
        return errorResult(error);
      }
    },
    observe: (output) => {
      const value = output as { task?: { id?: string; status?: string } };
      return `Claude Code task ${value.task?.id ?? "unknown"}: ${value.task?.status ?? "unknown"}`;
    },
  };

  const list: AgentTool = {
    name: "list_local_claude_code_tasks",
    description:
      "List recent and active managed local Claude Code tasks, including recovered tasks from a previous WeMail process.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler() {
      return { ok: true, tasks: service.list() };
    },
  };

  return [start, get, wait, cancel, list];
}
