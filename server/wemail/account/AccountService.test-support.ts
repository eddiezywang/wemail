import type {
  MailDatabaseAccountRecord,
  MailDatabaseConfigureAccountParams,
  MailDatabaseWriteResult,
} from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { MailDatabaseClient } from "../database/MailDatabaseClient.js";
import type { SecretStore } from "../security/SecretStore.js";

export function createMutableSecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    saveSecret: (key, value) => values.set(key, value),
    getSecret: (key) => values.get(key),
    deleteSecret: (key) => { values.delete(key); },
    isEncryptionAvailable: () => true,
  };
}

export function createAccountServiceTestClient(
  initial: MailDatabaseAccountRecord[] = [],
): {
  client: MailDatabaseClient;
  records: () => MailDatabaseAccountRecord[];
} {
  let records = [...initial];
  let commitVersion = 0;
  const client = {
    async listAccounts() {
      return [...records];
    },
    async configureAccount(input: MailDatabaseConfigureAccountParams) {
      commitVersion += 1;
      const record: MailDatabaseAccountRecord = {
        account: input.account,
        credentialRef: input.credentialRef,
        credentialGeneration: input.credentialGeneration,
        state: "active",
      };
      records = [
        record,
        ...records.filter((candidate) => candidate.account.id !== input.account.id),
      ];
      return {
        value: { accountId: input.account.id },
        commitVersion,
        changes: [{
          entityType: "account",
          entityPublicId: input.account.id,
          operation: "update",
        }],
      } satisfies MailDatabaseWriteResult<{ accountId: string }>;
    },
    onChanged() {
      return () => undefined;
    },
  } as unknown as MailDatabaseClient;
  return { client, records: () => [...records] };
}
