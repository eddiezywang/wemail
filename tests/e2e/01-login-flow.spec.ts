// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test, expect } from "@playwright/test";
import {
  launchElectron,
  loginWithFixture,
  waitFor,
} from "./helpers/electronApp";

test("login flow: unlogged state → save account → API reports it", async () => {
  const app = await launchElectron();
  try {
    const initial = await fetch(`${app.apiBaseUrl}/api/account/current`);
    expect(initial.ok).toBeTruthy();
    expect(await initial.json()).toEqual({ account: null });

    const saved = await loginWithFixture(app.apiBaseUrl);
    expect(saved.id).toBe("acct-e2e");

    // After login the composition must report the account on /current.
    const after = await waitFor(async () => {
      const res = await fetch(`${app.apiBaseUrl}/api/account/current`);
      const body = (await res.json()) as { account: { id?: string } | null };
      return body.account?.id === "acct-e2e" ? body.account : null;
    }, { label: "account-present" });
    expect(after.id).toBe("acct-e2e");
  } finally {
    await app.close();
  }
});
