import type { AccountConfig } from "../../../../shared/wemail/account.js";
import type { AppLogger } from "../../telemetry/AppLogger.js";
import type { WorkspaceComposition } from "./workspace.js";
import type { CuratorComposition } from "./curator.js";

export interface PerAccountState {
  accountId: string | undefined;
}

export interface BuildForAccount {
  (account: AccountConfig): void;
  reloadIntelligence(account: AccountConfig): Promise<void>;
}

export function createPerAccountState(): PerAccountState {
  return { accountId: undefined };
}

export function teardownAccount(opts: {
  state: PerAccountState;
  logger: AppLogger;
  workspace?: WorkspaceComposition;
  curator?: CuratorComposition;
}): Promise<void> {
  const previousAccountId = opts.state.accountId;
  opts.state.accountId = undefined;
  if (previousAccountId) {
    opts.workspace?.clearForAccount(previousAccountId);
    opts.curator?.clearForAccount(previousAccountId);
  }
  opts.logger.info("compose.account.local-services-detached", {
    accountId: previousAccountId,
  });
  return Promise.resolve();
}

export function createTransitionDriver(opts: {
  state: PerAccountState;
  logger: AppLogger;
  buildForAccount: (account: AccountConfig) => void;
  workspace?: WorkspaceComposition;
  curator?: CuratorComposition;
}): {
  runTransition: (event: {
    kind: "login" | "logout";
    account: AccountConfig | null;
  }) => void;
  getTransition: () => Promise<void>;
} {
  const transition = Promise.resolve();
  const runTransition = (event: {
    kind: "login" | "logout";
    account: AccountConfig | null;
  }): void => {
    const previousAccountId = opts.state.accountId;
    if (previousAccountId && previousAccountId !== event.account?.id) {
      opts.workspace?.clearForAccount(previousAccountId);
      opts.curator?.clearForAccount(previousAccountId);
    }
    if (event.kind === "login" && event.account) {
      opts.state.accountId = event.account.id;
      opts.buildForAccount(event.account);
      return;
    }
    opts.state.accountId = undefined;
    opts.logger.info("compose.account.logout", {});
  };
  return { runTransition, getTransition: () => transition };
}
