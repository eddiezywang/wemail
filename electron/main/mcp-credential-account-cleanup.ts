import type {
  AccountChangedEvent,
  AccountChangedSubscribable,
} from "../../server/wemail/account/AccountService.js";
import type { AccountConfig } from "../../shared/wemail/account.js";
import type { ManagedMcpCredentialVault } from "../../server/wemail/mcp/ManagedMcpCredentialVault.js";

export function registerManagedCredentialAccountCleanup(input: {
  accounts: AccountChangedSubscribable & {
    getCurrentAccount(): AccountConfig | null;
  };
  vault?: ManagedMcpCredentialVault;
}): () => void {
  let accountId = input.accounts.getCurrentAccount()?.id;
  return input.accounts.onAccountChanged((event: AccountChangedEvent) => {
    if (
      accountId &&
      (event.kind === "logout" || event.account?.id !== accountId)
    ) {
      input.vault?.delete(accountId);
    }
    accountId = event.account?.id;
  });
}
