import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MailboxCredentialEnvelope } from "../../shared/wemail/mailCoreProtocol.js";
import { MAIL_CORE_PROTOCOL_VERSION } from "../../shared/wemail/mailCoreProtocol.js";
import type { MailCoreAccountRuntimeOptions } from "../../server/wemail/mail-core/MailCoreAccountRuntime.js";
import type { MailMessage } from "../../shared/wemail/mail.js";

const state = vi.hoisted(() => ({
  runtimes: [] as Array<{
    options: MailCoreAccountRuntimeOptions;
    stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }>,
  producers: [] as Array<{
    configureAccount: ReturnType<typeof vi.fn<() => Promise<void>>>;
    getSyncCursor: ReturnType<typeof vi.fn<() => Promise<null>>>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../server/wemail/mail-core/MailCoreAccountRuntime.js", () => ({
  MailCoreAccountRuntime: class {
    stop = vi.fn(async () => undefined);
    constructor(readonly options: MailCoreAccountRuntimeOptions) { state.runtimes.push(this); }
    async start() {}
    health() { return { accountId: this.options.accountId }; }
  },
}));
vi.mock("./mail-database-producer.js", () => ({
  MailDatabaseProducer: class {
    configureAccount = vi.fn(async () => undefined);
    getSyncCursor = vi.fn(async () => null);
    close = vi.fn();
    constructor() { state.producers.push(this); }
  },
}));
vi.mock("../../server/wemail/mail-core/MailCoreRpcHost.js", () => ({
  MailCoreRpcHost: class { close() {} },
}));
vi.mock("../../server/wemail/performance/ResourceGovernor.js", () => ({
  ResourceGovernor: class { start() {} stop() {} },
}));

class Port extends EventEmitter {
  postMessage = vi.fn();
  start() {}
  close() { this.removeAllListeners(); }
}

const parentPortDescriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
let port: Port;
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const send = (data: unknown, ports: Port[] = []) => port.emit("message", { data, ports });
const credential = (id: string, generation = 1) => ({
  generation, account: { id },
}) as MailboxCredentialEnvelope;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  state.runtimes.length = 0;
  state.producers.length = 0;
  const parent = new EventEmitter();
  Object.defineProperty(process, "parentPort", { value: parent, configurable: true });
  port = new Port();
  await import("./entry.js");
  parent.emit("message", {
    data: { type: "mail-core.bootstrap", protocolVersion: MAIL_CORE_PROTOCOL_VERSION }, ports: [port],
  });
  await settle();
  expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "mail-core.ready" }));
  send({ type: "mail-core.attach-database-writer" }, [new Port()]);
});

afterEach(async () => {
  send({ type: "mail-core.shutdown" });
  await settle();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (parentPortDescriptor) Object.defineProperty(process, "parentPort", parentPortDescriptor);
  else Reflect.deleteProperty(process, "parentPort");
});

test("switching accounts stops the old Worker before waiting for new account configuration", async () => {
  send({ type: "mail-core.configure-account", credential: credential("first") });
  await settle();
  expect(state.runtimes).toHaveLength(1);
  const configuring = deferred();
  state.producers[0].configureAccount.mockImplementationOnce(() => configuring.promise);
  send({ type: "mail-core.configure-account", credential: credential("second") });
  await settle();
  expect(state.runtimes[0].stop).toHaveBeenCalledOnce();
  expect(state.runtimes).toHaveLength(1);
  configuring.resolve();
  await settle();
  expect(state.runtimes).toHaveLength(2);
  expect(state.runtimes[1].options.accountId).toBe("second");
});

test("overlapping credential reloads wait for the old Worker and start only the newest generation", async () => {
  send({ type: "mail-core.configure-account", credential: credential("first") });
  await settle();
  const stopping = deferred();
  state.runtimes[0].stop.mockImplementationOnce(() => stopping.promise);
  send({ type: "mail-core.configure-account", credential: credential("first", 2) });
  send({ type: "mail-core.configure-account", credential: credential("first", 3) });
  await settle();
  expect(state.runtimes).toHaveLength(1);
  expect(state.runtimes[0].stop).toHaveBeenCalledOnce();
  stopping.resolve();
  await settle();
  expect(state.runtimes).toHaveLength(2);
  expect(state.runtimes[1].options.credential?.generation).toBe(3);
});

test("a replaced database producer cannot start a Worker from its late cursor response", async () => {
  const reading = deferred();
  state.producers[0].getSyncCursor.mockImplementationOnce(async () => { await reading.promise; return null; });
  send({ type: "mail-core.configure-account", credential: credential("first") });
  await settle();
  expect(state.runtimes).toHaveLength(0);
  send({ type: "mail-core.attach-database-writer" }, [new Port()]);
  await settle();
  expect(state.producers[0].close).toHaveBeenCalled();
  expect(state.runtimes).toHaveLength(1);
  reading.resolve();
  await settle();
  expect(state.runtimes).toHaveLength(1);
});

test("detaching the database stops receipt until a replacement producer is configured", async () => {
  send({ type: "mail-core.configure-account", credential: credential("first") });
  await settle();
  send({ type: "mail-core.attach-database-writer" });
  await settle();
  expect(state.runtimes[0].stop).toHaveBeenCalledOnce();
  expect(state.runtimes).toHaveLength(1);
  send({ type: "mail-core.attach-database-writer" }, [new Port()]);
  await settle();
  expect(state.producers[1].configureAccount).toHaveBeenCalledOnce();
  expect(state.runtimes).toHaveLength(2);
});

test("metadata notifications suppress bootstrap, repair, and replay without inserted mail", async () => {
  send({ type: "mail-core.configure-account", credential: credential("first") });
  await settle();
  const committed = state.runtimes[0].options.onMetadataCommitted;
  const inserted = [{ id: "mail", subject: "Subject", from: { email: "sender@example.test" } }] as MailMessage[];
  port.postMessage.mockClear();
  await committed?.("bootstrap", { inserted, updatedCount: 0 }, inserted);
  await committed?.("historical", { inserted, updatedCount: 0 }, inserted);
  await committed?.("manual", { inserted: [], updatedCount: 0 }, inserted);
  expect(port.postMessage).not.toHaveBeenCalled();
  await committed?.("manual", { inserted, updatedCount: 0 }, inserted);
  await committed?.("live-poll", { inserted: [], updatedCount: 0 }, inserted);
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    type: "mail-core.mail-changed", accountId: "first", origin: "manual",
  }));
});

test("shutdown invalidates pending account configuration without resurrecting its Worker", async () => {
  const configuring = deferred();
  state.producers[0].configureAccount.mockImplementationOnce(() => configuring.promise);
  send({ type: "mail-core.configure-account", credential: credential("first") });
  await settle();
  send({ type: "mail-core.shutdown" });
  await settle();
  configuring.resolve();
  await settle();
  expect(state.runtimes).toHaveLength(0);
  expect(process.exit).toHaveBeenCalledWith(0);
});
