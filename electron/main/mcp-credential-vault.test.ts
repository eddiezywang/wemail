import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ElectronMcpCredentialVault,
  type McpCredentialEncryption,
} from "./mcp-credential-vault.js";

const directories: string[] = [];

function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-mcp-vault-"));
  directories.push(value);
  return value;
}

function encryption(available = true): McpCredentialEncryption {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) =>
      Buffer.from(`protected:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => {
      const encoded = value.toString().replace(/^protected:/, "");
      return Buffer.from(encoded, "base64").toString();
    },
  };
}

afterEach(() => {
  for (const value of directories.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe("ElectronMcpCredentialVault", () => {
  it("round-trips across instances without writing plaintext", () => {
    const baseDir = directory();
    const token = "wmcp_token-id.super-secret";
    new ElectronMcpCredentialVault(baseDir, encryption()).save({
      version: 1,
      accountId: "account-1",
      tokenId: "token-id",
      token,
    });

    const raw = fs.readFileSync(
      path.join(baseDir, "mcp-credential.json"),
      "utf8",
    );
    expect(raw).not.toContain(token);
    const reopened = new ElectronMcpCredentialVault(baseDir, encryption());
    expect(reopened.read("account-1")).toEqual({
      version: 1,
      accountId: "account-1",
      tokenId: "token-id",
      token,
    });
    expect(reopened.readStoredCredential()).toEqual({
      version: 1,
      accountId: "account-1",
      tokenId: "token-id",
      token,
    });
  });

  it("overwrites atomically and deletes only the matching account", () => {
    const baseDir = directory();
    const vault = new ElectronMcpCredentialVault(baseDir, encryption());
    vault.save({
      version: 1,
      accountId: "account-1",
      tokenId: "first",
      token: "wmcp_first.secret",
    });
    vault.save({
      version: 1,
      accountId: "account-1",
      tokenId: "second",
      token: "wmcp_second.secret",
    });
    expect(vault.read("account-1")?.tokenId).toBe("second");
    vault.delete("other-account");
    expect(vault.read("account-1")?.tokenId).toBe("second");
    vault.delete("account-1");
    expect(vault.read("account-1")).toBeNull();
  });

  it("fails closed when OS encryption is unavailable", () => {
    const vault = new ElectronMcpCredentialVault(directory(), encryption(false));
    expect(vault.isAvailable()).toBe(false);
    expect(() => vault.read("account-1")).toThrow(
      "mcp-credential-unavailable",
    );
    expect(() =>
      vault.save({
        version: 1,
        accountId: "account-1",
        tokenId: "token",
        token: "wmcp_token.secret",
      }),
    ).toThrow("mcp-credential-unavailable");
  });

  it("quarantines corrupt data without returning a credential", () => {
    const baseDir = directory();
    fs.writeFileSync(path.join(baseDir, "mcp-credential.json"), "{broken");
    const vault = new ElectronMcpCredentialVault(baseDir, encryption());
    expect(() => vault.read("account-1")).toThrow("mcp-credential-corrupt");
    expect(
      fs.readdirSync(baseDir).some((name) =>
        name.startsWith("mcp-credential.json.corrupt."),
      ),
    ).toBe(true);
  });
});
