# Workbench Resizable Panels Design

## Goal

Replace the hand-written Workbench column resizing logic with a mature split-pane library for the docked desktop layout, so divider dragging does not stall at iframe/content boundaries and always ends cleanly when the pointer is released or capture is lost.

## Scope

In scope:

- Use `react-resizable-panels` for the non-narrow Workbench layout when the detail column and docked AI panel are visible.
- Preserve current visual structure: nav, mail list, detail, and AI panel remain in the same left-to-right order.
- Preserve current narrow drawer behavior.
- Preserve current floating AI behavior when `showDetailColumn=false`; it can remain on the current CSS grid path.
- Preserve localStorage-backed width preferences per `wide` and `medium` viewport mode.
- Preserve existing separator visual styling and test ids where practical.

Out of scope:

- Redesigning the Workbench layout.
- Changing AI panel content, mail detail rendering, or narrow drawer behavior.
- Reworking unrelated compose/floating-panel drag logic.

## Architecture

`Workbench` will keep ownership of viewport mode, agent placement, active modal state, and persisted pane sizes. For the docked non-narrow layout, it will render a `Group orientation="horizontal"` with `Panel` and `Separator` components from `react-resizable-panels`.

The current `react-resizable-panels` release supports pixel sizes for panel constraints and defaults, and exposes `onLayoutChanged` for saving after a user resize completes. The migration will use pixel defaults/min/max values where possible so the current localStorage shape can remain unchanged and drag persistence does not write on every pointer move.

The CSS grid path will remain for narrow and floating-agent layouts. That limits the change to the bug-prone docked splitter path that the user is actively dragging in the screenshot.

## Components

- `app/components/layout/Workbench.tsx`
  - Import `Group`, `Panel`, and `Separator`.
  - Remove the docked-layout hand-written `dragStateRef`, `pointermove`, and `pointerup` logic.
  - Add layout extraction helpers that persist pixel widths from the library layout callback.
  - Render panel handles with existing test ids and separator line classes.

- `app/components/layout/Workbench.test.tsx`
  - Keep current layout tests that verify slots and placement.
  - Update docked layout assertions from `gridTemplateColumns` to panel rendering behavior.
  - Add tests for persisted width hydration and layout persistence through the library callback.

- `package.json` and `bun.lock`
  - Add `react-resizable-panels` as a runtime dependency.

## Error Handling

If the Workbench container width is unavailable during the first render, the library receives the mode-specific default pixel sizes. Once the component measures its container, panels continue to respect their configured min/max pixel constraints.

Invalid localStorage values continue to be ignored by `readPersistedPaneSizes()`. Pixel min/max values remain the existing `MIN_*_WIDTH` and `MAX_*_WIDTH` constants.

## Testing

Focused tests will cover:

- Docked Workbench renders library-backed resize handles.
- Persisted pane widths are reflected in initial panel sizes.
- Library `onLayout` persists updated pane widths.
- Narrow and floating layouts continue to render without the docked agent resize handle.

Verification commands:

- `vitest run app/components/layout/Workbench.test.tsx`
- `tsc -p tsconfig.json --noEmit --pretty false`
