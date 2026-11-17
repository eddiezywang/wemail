import { describe, expect, it, vi } from "vitest";
import { registerManagedCredentialAccountCleanup } from "./mcp-credential-account-cleanup.js";

describe("registerManagedCredentialAccountCleanup", () => {
  it("deletes the prior account vault on logout and replacement", () => {
    let listener: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const remove = vi.fn();
    const dispose = registerManagedCredentialAccountCleanup({
      accounts: {
        getCurrentAccount: () => ({ id: "account-1" }) as any,
        onAccountChanged: (value) => {
          listener = value;
          return unsubscribe;
        },
      },
      vault: {
        isAvailable: () => true,
        read: () => null,
        save: vi.fn(),
        delete: remove,
      },
    });

    listener?.({ kind: "login", account: { id: "account-2" } });
    expect(remove).toHaveBeenCalledWith("account-1");
    listener?.({ kind: "logout", account: null });
    expect(remove).toHaveBeenCalledWith("account-2");
    dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("keeps the vault for a same-account login refresh", () => {
    let listener: ((event: any) => void) | undefined;
    const remove = vi.fn();
    registerManagedCredentialAccountCleanup({
      accounts: {
        getCurrentAccount: () => ({ id: "account-1" }) as any,
        onAccountChanged: (value) => {
          listener = value;
          return () => {};
        },
      },
      vault: {
        isAvailable: () => true,
        read: () => null,
        save: vi.fn(),
        delete: remove,
      },
    });
    listener?.({ kind: "login", account: { id: "account-1" } });
    expect(remove).not.toHaveBeenCalled();
  });
});
