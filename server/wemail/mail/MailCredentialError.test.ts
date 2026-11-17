import assert from "node:assert/strict";
import { test } from "node:test";
import { MailProviderCommandError } from "./ImapSmtpMailProvider.js";
import { isMailCredentialInvalidError } from "./MailCredentialError.js";

function commandError(options: {
  phase?: "imap.login" | "imap.search";
  responseStatus?: string;
  responseText?: string;
  code?: string;
}) {
  return new MailProviderCommandError({
    phase: options.phase ?? "imap.login",
    cause: {
      message: "Command failed",
      responseStatus: options.responseStatus,
      responseText: options.responseText,
      code: options.code,
    },
  });
}

test("classifies a corporate IMAP password-invalid response", () => {
  assert.equal(
    isMailCredentialInvalidError(
      commandError({
        responseStatus: "NO",
        responseText: "LOGIN Login error or password error",
      }),
    ),
    true,
  );
});

test("does not classify network or non-login failures as credential invalid", () => {
  assert.equal(
    isMailCredentialInvalidError(
      commandError({ responseStatus: "NO", responseText: "Connection unavailable" }),
    ),
    false,
  );
  assert.equal(
    isMailCredentialInvalidError(
      commandError({
        phase: "imap.search",
        responseStatus: "NO",
        responseText: "LOGIN Login error or password error",
      }),
    ),
    false,
  );
  assert.equal(
    isMailCredentialInvalidError(
      commandError({ code: "EAI_AGAIN", responseText: "getaddrinfo EAI_AGAIN" }),
    ),
    false,
  );
});

test("classifies a server-refused login NO in any language as credential invalid", () => {
  assert.equal(
    isMailCredentialInvalidError(
      commandError({ responseStatus: "NO", responseText: "LOGIN 登录错误或密码错误" }),
    ),
    true,
  );
  assert.equal(
    isMailCredentialInvalidError(
      commandError({ responseStatus: "NO", responseText: "AUTHENTICATIONFAILED" }),
    ),
    true,
  );
});

test("classifies a transient login NO as retryable rather than credential invalid", () => {
  assert.equal(
    isMailCredentialInvalidError(
      commandError({ responseStatus: "NO", responseText: "Server busy, try again later" }),
    ),
    false,
  );
});
