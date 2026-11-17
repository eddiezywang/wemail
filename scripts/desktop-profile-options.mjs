import path from "node:path";

const DEFAULT_INSPECT_PORT = 9229;

export function resolveDesktopProfileLaunch(args, env, cwd) {
  let profile = false;
  let trace = false;
  const electronArgs = [];

  for (const arg of args) {
    if (arg === "--wemail-profile") {
      profile = true;
      continue;
    }
    if (arg === "--wemail-trace") {
      profile = true;
      trace = true;
      continue;
    }
    electronArgs.push(arg);
  }

  if (profile) {
    electronArgs.unshift(`--inspect=${resolveInspectPort(env.WEMAIL_INSPECT_PORT)}`);
  }

  const childEnv = { ...env };
  const remoteDebuggingPort = env.WEMAIL_REMOTE_DEBUGGING_PORT?.trim();
  if (remoteDebuggingPort) {
    const port = resolveRemoteDebuggingPort(remoteDebuggingPort);
    electronArgs.unshift(`--remote-debugging-port=${port}`);
  }
  if (trace) {
    childEnv.WEMAIL_DEV_TRACE = "1";
    childEnv.WEMAIL_TRACE_OUTPUT_DIR = path.resolve(
      cwd,
      env.WEMAIL_TRACE_OUTPUT_DIR ?? "workspace/reports/performance",
    );
  }

  return { electronArgs, childEnv, profile, trace };
}

export function resolveRemoteDebuggingPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `WEMAIL_REMOTE_DEBUGGING_PORT must be an integer in [1024,65535], received ${value}`,
    );
  }
  return port;
}
export function resolveInspectPort(value) {
  if (value === undefined || value.trim() === "") return DEFAULT_INSPECT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEMAIL_INSPECT_PORT must be an integer in [1, 65535], received ${value}`);
  }
  return port;
}
