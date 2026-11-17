export interface SafeWritable {
  write(
    chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean;
  on?(
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ): unknown;
  writable?: boolean;
  destroyed?: boolean;
}

interface StreamState {
  failed: boolean;
  listenerAttached: boolean;
}

const states = new WeakMap<object, StreamState>();

/**
 * Best-effort logging for Electron processes that may outlive the terminal
 * or launcher pipe they inherited. Closed Windows pipes report EPIPE through
 * an asynchronous `error` event, so try/catch around write() is insufficient.
 */
export function safeStreamWrite(
  stream: SafeWritable,
  value: string,
): boolean {
  const key = stream as object;
  let state = states.get(key);
  if (!state) {
    state = { failed: false, listenerAttached: false };
    states.set(key, state);
  }
  if (!state.listenerAttached && typeof stream.on === "function") {
    state.listenerAttached = true;
    stream.on("error", () => {
      state!.failed = true;
    });
  }
  if (state.failed || stream.destroyed === true || stream.writable === false) {
    return false;
  }
  try {
    return stream.write(value, (error) => {
      if (error) state!.failed = true;
    });
  } catch {
    state.failed = true;
    return false;
  }
}
