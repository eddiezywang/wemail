export interface DirectoryDepartment {
  id: string;
  accountId: string;
  parentId?: string;
  name: string;
  path: string;
  childCount: number;
  syncedAt: string;
}

export interface DirectoryContactSummary {
  id: string;
  accountId: string;
  name: string;
  email: string;
  aliases: string[];
  departmentId?: string;
  departmentPath?: string;
  title?: string;
  mobile?: string;
  companyPhone?: string;
}

export interface DirectoryContactSearchResult {
  contacts: DirectoryContactSummary[];
  total: number;
  remoteAvailable: boolean;
}

export interface DirectoryContactQueryOptions {
  departmentId?: string;
  includeDescendants?: boolean;
  limit?: number;
  offset?: number;
}

export type DirectorySyncState = "idle" | "running" | "completed" | "failed";

export interface DirectorySyncStatus {
  accountId: string;
  state: DirectorySyncState;
  phase?: "login" | "departments" | "contacts" | "commit";
  processedDepartments: number;
  processedContacts: number;
  lastSuccessfulAt?: string;
  updatedAt: string;
  errorCode?: string;
  errorMessage?: string;
}

export type RecipientResolution =
  | { input: string; status: "exact"; contact: DirectoryContactSummary }
  | { input: string; status: "ambiguous"; candidates: DirectoryContactSummary[] }
  | { input: string; status: "not_found" }
  | { input: string; status: "external"; email: string };

export type RecipientValidation =
  | { email: string; status: "valid"; contact?: DirectoryContactSummary }
  | { email: string; status: "invalid" }
  | { email: string; status: "external" }
  | { email: string; status: "unavailable"; reason: string };
