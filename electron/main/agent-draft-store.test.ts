import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDraftStore } from "./agent-draft-store.js";

const temporaryDirectories: string[] = [];

function createStore(now: () => number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-agent-draft-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    store: new AgentDraftStore(directory, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
    }, now, 1_000),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("AgentDraftStore", () => {
  it("encrypts drafts, isolates accounts and expires old content", () => {
    let now = 1_000;
    const { directory, store } = createStore(() => now);
    store.save("account-a", "conversation-1", "企业邮件正文");
    store.save("account-b", "conversation-1", "另一账号草稿");

    expect(store.get("account-a", "conversation-1")).toBe("企业邮件正文");
    expect(fs.readFileSync(path.join(directory, "agent-drafts.json"), "utf8"))
      .not.toContain("企业邮件正文");
    store.clearAccount("account-a");
    expect(store.get("account-a", "conversation-1")).toBeUndefined();
    expect(store.get("account-b", "conversation-1")).toBe("另一账号草稿");

    now = 2_001;
    expect(store.get("account-b", "conversation-1")).toBeUndefined();
  });
});
