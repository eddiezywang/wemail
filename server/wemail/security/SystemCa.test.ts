import assert from "node:assert/strict";
import { test } from "node:test";
import { enableSystemCertificateAuthorities } from "./SystemCa.js";

test("enableSystemCertificateAuthorities merges bundled and system CAs once", () => {
  const calls: string[][] = [];
  const result = enableSystemCertificateAuthorities({
    getCACertificates(type) {
      if (type === "default") return ["bundled-a", "shared-ca"];
      if (type === "system") return ["shared-ca", "system-b"];
      return [];
    },
    setDefaultCACertificates(certs) {
      calls.push(certs);
    },
  });

  assert.deepEqual(result, { enabled: true, added: 1, total: 3 });
  assert.deepEqual(calls, [["bundled-a", "shared-ca", "system-b"]]);

  const second = enableSystemCertificateAuthorities({
    getCACertificates() {
      throw new Error("should not be called twice");
    },
    setDefaultCACertificates() {
      throw new Error("should not be called twice");
    },
  });
  assert.deepEqual(second, { enabled: true, added: 0, total: 0 });
});
