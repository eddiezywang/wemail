// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// CI runs the renderer suite on Node 20, while the Electron runtime (and local
// developer machines) ship Node 22+/24. `Object.groupBy` is used by the MCP
// settings panel at render time; without this polyfill the component throws
// before it can mount and every assertion that waits for it times out.
if (typeof (Object as { groupBy?: unknown }).groupBy !== "function") {
  Object.defineProperty(Object, "groupBy", {
    configurable: true,
    writable: true,
    value: (
      items: Iterable<unknown>,
      callback: (item: unknown, index: number) => PropertyKey,
    ): Record<PropertyKey, unknown[]> => {
      const groups: Record<PropertyKey, unknown[]> = Object.create(null);
      let index = 0;
      for (const item of items) {
        const key = callback(item, index++);
        (groups[key] ??= []).push(item);
      }
      return groups;
    },
  });
}

afterEach(() => {
  cleanup();
});
