# Email Body Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make email body display preserve HTML/plaintext type, avoid iframe truncation, and parse complex MIME bodies more reliably.

**Architecture:** Preserve `bodyHtml` and `bodyText` from the desktop API adapter into the app `Email` type. Route HTML bodies through the sandboxed iframe and plaintext bodies through a plain React renderer. Upgrade backend body extraction to use the existing `postal-mime` dependency first, with the current lightweight extractor as fallback.

**Tech Stack:** React 19, TypeScript, Vitest, Node `node:test`, DOMPurify, postal-mime, Hono desktop API.

## Global Constraints

- Keep `EmailIframe` sandboxed and theme-isolated.
- Do not grant email HTML same-origin access.
- Do not log raw `bodyText` or `bodyHtml`.
- Preserve existing attachment lazy-loading behavior.
- Do not redesign the mail detail page.

---

### Task 1: Preserve Body Type In Frontend API Mapping

**Files:**
- Modify: `app/types/index.ts`
- Modify: `app/services/api.ts`
- Test: `app/services/api.test.ts`

**Interfaces:**
- Produces: `Email.bodyHtml?: string | null`, `Email.bodyText?: string | null`, and compatibility `Email.body?: string | null`.
- Consumes: desktop API `WemailMessage.bodyHtml?: string`, `WemailMessage.bodyText?: string`.

- [x] **Step 1: Write failing test**

Add a test to `app/services/api.test.ts` asserting `api.getEmail()` preserves both body fields:

```typescript
test("preserves desktop message html and text bodies separately", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        message: {
          id: "msg-body",
          accountId: "acct-1",
          folder: "INBOX",
          messageId: "<msg-body@example.com>",
          from: { email: "alice@example.com" },
          to: [{ email: "me@example.com" }],
          subject: "Body",
          snippet: "Plain",
          receivedAt: "2026-04-27T12:00:00.000Z",
          bodyText: "Plain\nbody",
          bodyHtml: "<p>HTML body</p>",
          hasAttachments: false,
          attachments: [],
          flags: { seen: true, flagged: false, answered: false, draft: false },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const email = await api.getEmail("acct-1", "msg-body");

  expect(email.bodyHtml).toBe("<p>HTML body</p>");
  expect(email.bodyText).toBe("Plain\nbody");
  expect(email.body).toBe("<p>HTML body</p>");
});
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run app/services/api.test.ts --testNamePattern "preserves desktop message html and text bodies separately"`

Expected: FAIL because `bodyHtml` and `bodyText` are not present on returned `Email`.

- [x] **Step 3: Implement mapping**

Add optional `bodyHtml` and `bodyText` fields to `Email` in `app/types/index.ts`. In `mapWemailMessage`, assign both fields and keep `body: bodyHtml || bodyText || null`.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run app/services/api.test.ts --testNamePattern "preserves desktop message html and text bodies separately"`

Expected: PASS.

### Task 2: Render Plaintext Separately From HTML

**Files:**
- Create: `app/components/email-panel/EmailBodyRenderer.tsx`
- Modify: `app/components/email-panel/SingleMessageView.tsx`
- Modify: `app/components/email-panel/ThreadMessage.tsx`
- Test: `app/components/email-panel/EmailBodyRenderer.test.tsx`

**Interfaces:**
- Consumes: `Email.bodyHtml`, `Email.bodyText`, `Email.body`, `Email.attachments`.
- Produces: `EmailBodyRenderer({ email, mailboxId })` that chooses HTML, plaintext, or empty state.

- [x] **Step 1: Write failing tests**

Create `app/components/email-panel/EmailBodyRenderer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import EmailBodyRenderer from "./EmailBodyRenderer";
import type { Email } from "~/types";

vi.mock("~/components/EmailIframe", () => ({
  default: ({ body }: { body: string }) => (
    <div data-testid="email-iframe">{body}</div>
  ),
}));

const baseEmail: Email = {
  id: "msg-1",
  subject: "Subject",
  sender: "sender@example.com",
  recipient: "me@example.com",
  date: "2026-04-27T12:00:00.000Z",
  read: true,
  starred: false,
  body: null,
  attachments: [],
};

describe("EmailBodyRenderer", () => {
  test("renders plaintext as escaped pre-wrapped text", () => {
    render(
      <EmailBodyRenderer
        email={{
          ...baseEmail,
          bodyText: "Hello\n<script>alert(1)</script>",
        }}
      />,
    );

    expect(screen.getByText(/Hello/)).toHaveClass("whitespace-pre-wrap");
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.queryByTestId("email-iframe")).not.toBeInTheDocument();
  });

  test("renders html through EmailIframe", () => {
    render(
      <EmailBodyRenderer
        email={{
          ...baseEmail,
          bodyHtml: "<p>Hello HTML</p>",
          bodyText: "Hello text",
        }}
        mailboxId="acct-1"
      />,
    );

    expect(screen.getByTestId("email-iframe")).toHaveTextContent("<p>Hello HTML</p>");
  });
});
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run app/components/email-panel/EmailBodyRenderer.test.tsx`

Expected: FAIL because `EmailBodyRenderer` does not exist.

- [x] **Step 3: Implement renderer and wire views**

Create `EmailBodyRenderer.tsx` with HTML/plaintext/empty selection. Replace direct `EmailIframe` usage in `SingleMessageView.tsx` and `ThreadMessage.tsx` with `EmailBodyRenderer`.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run app/components/email-panel/EmailBodyRenderer.test.tsx`

Expected: PASS.

### Task 3: Harden Iframe Auto Height

**Files:**
- Modify: `app/components/EmailIframe.tsx`
- Test: `app/components/EmailIframe.test.tsx`

**Interfaces:**
- Produces: iframe `srcdoc` with height reporting on startup, resize observation, mutation observation, image load, and image error.

- [x] **Step 1: Write failing test**

Add a test to `app/components/EmailIframe.test.tsx`:

```tsx
it("srcdoc reports height after image load and resize events", () => {
  const { container } = render(
    <EmailIframe body={'<img src="https://example.com/a.png" alt="A">'} autoSize />,
  );
  const iframe = container.querySelector("iframe") as HTMLIFrameElement | null;

  expect(iframe).not.toBeNull();
  expect(iframe!.srcdoc).toContain("ResizeObserver");
  expect(iframe!.srcdoc).toContain("MutationObserver");
  expect(iframe!.srcdoc).toContain("addEventListener(\"load\"");
  expect(iframe!.srcdoc).toContain("addEventListener(\"error\"");
});
```

- [x] **Step 2: Verify RED**

Run: `npx vitest run app/components/EmailIframe.test.tsx --testNamePattern "srcdoc reports height after image load and resize events"`

Expected: FAIL because current `srcdoc` only has delayed `reportHeight()` calls.

- [x] **Step 3: Implement height script**

Update the auto-size script to install `ResizeObserver`, `MutationObserver`, and image `load/error` listeners while keeping the existing delayed reports.

- [x] **Step 4: Verify GREEN**

Run: `npx vitest run app/components/EmailIframe.test.tsx --testNamePattern "srcdoc reports height after image load and resize events"`

Expected: PASS.

### Task 4: Upgrade Backend MIME Body Extraction

**Files:**
- Modify: `server/wemail/mail/normalizeMail.ts`
- Test: `server/wemail/mail/normalizeMail.test.ts`

**Interfaces:**
- Produces: async `normalizeMail(input, context): Promise<MailMessage>` and `extractBodies(source)` that prefers `postal-mime` parsed `text` and `html`, then falls back to the current lightweight extractor.
- Consumes: `ImapSmtpMailProvider.fetchMessagesByUid`, which already runs inside an async loop and can `await normalizeMail(...)`.

- [x] **Step 1: Write failing tests**

Add tests to `server/wemail/mail/normalizeMail.test.ts`:

```typescript
test("normalizeMail extracts nested multipart related alternative bodies", () => {
  const outer = "outer-boundary";
  const alt = "alt-boundary";
  const source = rfc822(
    { "Content-Type": `multipart/related; boundary="${outer}"` },
    `--${outer}\r\n` +
      `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
      "Plain nested body\r\n" +
      `--${alt}\r\n` +
      "Content-Type: text/html; charset=utf-8\r\n\r\n" +
      '<html><body><style>.title{color:red}</style><p class="title">HTML nested body</p><img src="cid:img-1"></body></html>\r\n' +
      `--${alt}--\r\n` +
      `--${outer}\r\n` +
      "Content-Type: image/png\r\n" +
      "Content-Disposition: inline; filename=\"chart.png\"\r\n" +
      "Content-ID: <img-1>\r\n\r\n" +
      "PNGDATA\r\n" +
      `--${outer}--\r\n`,
  );

  const m = normalizeMail(
    {
      uid: 30,
      envelope: {
        date: "2026-04-23T12:00:00Z",
        subject: "nested",
        messageId: "<nested@example.com>",
        from: [{ address: "a@x.com" }],
        to: [{ address: "b@x.com" }],
      },
      bodyStructure: { type: "multipart", subtype: "related" },
      source,
    },
    CTX,
  );

  assert.equal(m.bodyText, "Plain nested body");
  assert.ok(m.bodyHtml?.includes("HTML nested body"));
  assert.ok(m.bodyHtml?.includes("<style>"));
});
```

- [x] **Step 2: Verify RED**

Run: `npx tsx --test server/wemail/mail/normalizeMail.test.ts --test-name-pattern "nested multipart related alternative"`

Expected: FAIL because current lightweight extractor does not fully preserve the nested HTML style case.

- [x] **Step 3: Implement parser-backed extraction**

Change `NormalizeMailFn` in `shared/wemail/mail.ts` to return `Promise<MailMessage>`. Import `PostalMime` in `server/wemail/mail/normalizeMail.ts`, call `await PostalMime.parse(sourceToRaw(input.source), { attachmentEncoding: "base64" })`, and use parsed `text` / `html` when present. Keep the existing lightweight extractor as fallback when parsing throws or yields no body. Update `ImapSmtpMailProvider.fetchMessagesByUid` to `await normalizeMail(...)`. Update existing `normalizeMail.test.ts` tests to `async` and `await normalizeMail(...)`.

- [x] **Step 4: Verify GREEN**

Run: `npx tsx --test server/wemail/mail/normalizeMail.test.ts --test-name-pattern "nested multipart related alternative"`

Expected: PASS.

### Task 5: Full Verification

**Files:**
- Verify all files touched in Tasks 1-4.

- [x] **Step 1: Run focused frontend tests**

Run: `npx vitest run app/services/api.test.ts app/components/email-panel/EmailBodyRenderer.test.tsx app/components/EmailIframe.test.tsx`

Expected: all selected Vitest tests pass.

- [x] **Step 2: Run focused backend tests**

Run: `npx tsx --test server/wemail/mail/normalizeMail.test.ts`

Expected: all normalizeMail tests pass.

- [x] **Step 3: Run type checks**

Run: `npm run typecheck:server`

Expected: exit 0.
Run: `npm run typecheck`

Expected: exit 0.
