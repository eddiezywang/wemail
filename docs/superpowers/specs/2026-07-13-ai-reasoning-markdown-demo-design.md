# WeMail AI reasoning and Markdown demo

## Goal

Create a self-contained browser demo that makes the two proposed AI-panel improvements easy to evaluate in the context of the WeMail workbench:

1. Reasoning is visible and expanded while the assistant is working, then collapses after completion.
2. The completed answer is presented as structured Markdown-like content rather than a wall of raw text.

## Scope

The demo is a static HTML page with local CSS and JavaScript. It contains a WeMail-style shell with:

- mailbox navigation;
- an inbox list;
- a selected email detail view;
- a right-side WeMail AI panel;
- controls for switching between `thinking` and `completed` states.

It does not call the product API or modify the production React application.

## Interaction design

- The completed state is the default so the target visual result is immediately visible.
- In the thinking state, the reasoning panel opens and shows a live timer, progress steps, and a streaming-style preview. The final answer is replaced by a generation placeholder.
- In the completed state, the reasoning content collapses to a compact status row. A user can still expand it manually.
- The final answer is rendered with headings, lists, status markers, a table, and linked mail references.
- The top demo controls switch state without reloading the page. A replay control runs a short thinking-to-completed transition.

## Visual direction

Use the existing WeMail warm paper palette, coral accent, editorial serif display face, compact sans-serif UI text, thin borders, and restrained shadows. The AI panel should feel like a focused work surface rather than a generic chat widget.

## Acceptance criteria

- The file opens directly from disk in a modern desktop browser.
- The full shell remains usable at desktop widths and degrades gracefully below 1180px.
- The two AI states are visually distinct and demonstrate the intended lifecycle.
- The completed state contains no visible reasoning transcript by default.
- The final answer has clear Markdown hierarchy and readable mail-oriented content.
