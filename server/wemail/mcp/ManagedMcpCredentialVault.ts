export interface ManagedMcpCredential {
  version: 1;
  accountId: string;
  tokenId: string;
  token: string;
}

export interface ManagedMcpCredentialVault {
  isAvailable(): boolean;
  read(accountId: string): ManagedMcpCredential | null;
  save(credential: ManagedMcpCredential): void;
  delete(accountId: string): void;
}
