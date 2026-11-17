# Compose Empty Guidance Pointer Behavior

## Goal

Fix the empty compose editor guidance so users can place the caret on the
first body line without the guidance intercepting the click. Preserve the
existing copy and visual styling.

## Interaction

- The gray guidance text is display-only and has no click handler or
  interactive semantic role.
- Pointer input over the gray guidance passes through to the TipTap editor,
  allowing its native click behavior to focus the body and place the caret.
- Only the blue `使用 AI 写作` text is an interactive button.
- Activating the blue button focuses the AI prompt below the editor.
- The complete guidance remains visible only while the draft has no editable
  compose content. Once the user enters body content, the existing
  `hasEditableComposeContent` condition hides it.

## Implementation Boundary

Keep the current empty-guidance overlay API and empty-content detection.
Change only the guidance markup and pointer-event boundary:

- the overlay remains pointer-transparent;
- the gray copy remains non-interactive;
- the blue action alone opts back into pointer events and invokes the
  existing AI prompt focus handle.

Do not replace the guidance with a TipTap placeholder extension, change its
copy, or add programmatic editor focusing for gray-text clicks.

## Accessibility

Expose `使用 AI 写作` as the only button in the guidance. The gray text is
ordinary presentational text. Keyboard activation of the button continues to
focus the AI prompt.

## Tests

Add focused renderer coverage proving:

1. the full guidance sentence is not exposed as one button;
2. `使用 AI 写作` is the only guidance button and focuses the AI prompt once;
3. the overlay leaves the non-action guidance region pointer-transparent;
4. existing editable-content behavior continues to remove the guidance.

Run the focused renderer tests, the renderer test suite, TypeScript
typechecking, and the renderer production build.
