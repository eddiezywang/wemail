# Floating Agent Panel Resize Design

## Goal

Restore width resizing for the right-side Agent panel when no mail is selected and the panel uses the floating placement. Keep the panel anchored to the right, persist its width, and preserve the existing docked resize behavior used while a mail detail is open.

## Current Failure

`Workbench` renders the floating Agent panel as an absolutely positioned element with a persisted fixed width. The July 7 resizable-panel refactor removed the floating layout's Agent resize handle and its pointer-drag path. The docked layout still renders `workbench-agent-resizer`, but the floating layout intentionally omits it, so the visible gap beside the Agent panel cannot be dragged.

## Design

Add a dedicated resize handle immediately to the left of the floating Agent panel. The panel remains anchored with its right edge fixed. Pointer movement changes only the persisted Agent width:

```text
nextWidth = clamp(startWidth - (currentX - startX), minWidth, maxWidth)
```

The floating handler will reuse the existing mode-specific `MIN_AGENT_WIDTH`, `MAX_AGENT_WIDTH`, `paneSizes`, and `persistPaneSize` infrastructure. Docked mode will continue to use `react-resizable-panels`; no docked layout behavior or persistence format changes.

The handle will:

- expose `role="separator"`, `aria-orientation="vertical"`, and an Agent resize label;
- use the existing column-resize cursor and hover/active visual treatment;
- capture pointer movement through window listeners so dragging remains stable outside the narrow handle;
- clear drag state on pointer up, pointer cancel, placement change, and component unmount;
- remain available only in non-narrow floating placement.

## Persistence

Floating and docked Agent widths continue to share `wemail.workbenchPaneSizes`, keyed by viewport mode. Resizing in either placement therefore becomes the next default width in the other placement. No migration or new storage key is required.

## Tests

1. Update the Workbench component test that currently expects no floating Agent splitter.
2. Simulate pointer down, move, and up in floating placement and assert the grid/panel width and persisted Agent width change.
3. Preserve existing docked resize persistence coverage.
4. Add a Playwright acceptance test that opens the Agent panel with no selected mail, drags its left edge, and verifies the rendered width changes materially.
5. Run focused Workbench tests, TypeScript checks, browser acceptance, desktop rebuild, and white-screen startup validation.

## Non-goals

- Moving the floating panel away from the right edge.
- Vertical resizing.
- Changing narrow drawer behavior.
- Replacing the docked `react-resizable-panels` implementation.
- Introducing a general-purpose resizable-window framework.
