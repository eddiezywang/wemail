import type {
  DirectoryContactQueryOptions,
  DirectoryContactSearchResult,
} from "../../shared/wemail/directory.js";

export interface DesktopDirectorySearchInput extends DirectoryContactQueryOptions {
  query: string;
}

export interface DirectorySearchRuntime {
  composition: {
    accountService: {
      getCurrentAccount(): { id: string } | null | undefined;
    };
    directoryService: {
      searchContacts(
        accountId: string,
        query: string,
        options?: DirectoryContactQueryOptions,
      ): Promise<DirectoryContactSearchResult>;
    };
  };
}

export function createDesktopDirectorySearch(
  getRuntime: () => DirectorySearchRuntime | null,
  getApiPort: () => number | null = () => null,
) {
  return async (input: DesktopDirectorySearchInput) => {
    if (!input || typeof input.query !== "string") {
      throw new Error("directory-query-required");
    }

    const runtime = getRuntime();
    const account = runtime?.composition.accountService.getCurrentAccount();
    if (!runtime || !account) {
      const port = getApiPort();
      if (!port) throw new Error("account-required");
      const params = new URLSearchParams({ query: input.query, q: input.query });
      if (input.departmentId) params.set("departmentId", input.departmentId);
      if (input.includeDescendants) params.set("includeDescendants", "true");
      if (typeof input.limit === "number") params.set("limit", String(input.limit));
      if (typeof input.offset === "number") params.set("offset", String(input.offset));
      const response = await fetch(
        `http://127.0.0.1:${port}/api/directory/contacts?${params.toString()}`,
      );
      if (!response.ok) throw new Error(response.status === 401 ? "account-required" : "directory-search-failed");
      return response.json() as Promise<{ ok: true } & DirectoryContactSearchResult>;
    }

    const result = await runtime.composition.directoryService.searchContacts(
      account.id,
      input.query,
      {
        departmentId:
          typeof input.departmentId === "string" && input.departmentId
            ? input.departmentId
            : undefined,
        includeDescendants: input.includeDescendants === true,
        limit:
          typeof input.limit === "number" && Number.isFinite(input.limit)
            ? input.limit
            : undefined,
        offset:
          typeof input.offset === "number" && Number.isFinite(input.offset)
            ? input.offset
            : undefined,
      },
    );
    return { ok: true as const, ...result };
  };
}
