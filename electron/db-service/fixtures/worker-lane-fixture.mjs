import { parentPort, threadId, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("worker-lane fixture requires a parent port");

parentPort.on("message", (message) => {
  if (message?.type !== "query") return;
  setTimeout(() => {
    parentPort.postMessage({
      type: "response",
      requestId: message.request.requestId,
      ok: true,
      result: { requestId: message.request.requestId },
      queueMs: 0,
      handlerMs: 100,
    });
  }, 100);
});

parentPort.postMessage({
  type: "ready",
  label: workerData.label,
  threadId,
  commitVersion: 0,
  queueDepth: 0,
});
