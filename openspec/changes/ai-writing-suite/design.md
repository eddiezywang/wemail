# AI Writing Suite - Design

## Safety Boundary

AI writing creates drafts only. Sending, deleting, moving, or archiving mail must happen through separate explicit user-facing APIs.

## Result Contract

Writing may return either:

```ts
{ status: "draft"; draftMarkdown: string; language: string; styleId?: string; metadata: AiResultMetadata }
```

or:

```ts
{ status: "needsClarification"; questions: string[]; missingFields: string[] }
```

Reply drafts must not include subject lines, mail headers, or fake signatures.

## Upstream-Aligned Compose Controller

The compose editor is the canonical draft surface. AI generation writes a
successful result directly into the editable body; there is no secondary
preview or accept step.

The controller maintains two independent histories:

- Prompt history stores user instructions. Selecting an entry fills the input
  but does not submit it.
- Body history stores successful AI writes. Clarification turns do not create a
  body version. Generating from an older version truncates its forward branch.

The controller states are:

```text
idle -> generating -> draft
                  \-> needsClarification -> generating
                  \-> failed -> idle
```

Enter submits to AI and Shift+Enter inserts a newline. While generating, the
send action becomes an abort action. A clarification response leaves the
current editor body unchanged and the user's next answer is submitted with the
clarification context.

Signatures and quoted original messages are protected compose regions. They
are excluded from `currentBody` sent to AI and merged unchanged after every
successful generation or version navigation.

Local compose saves live in `mail_drafts`. The mail API projects those records
into Drafts-folder message summaries/details so an AI-generated draft does not
disappear after the compose window closes. The projection retains the original
message link and protected HTML markers; delete/send cleanup removes the local
record.
