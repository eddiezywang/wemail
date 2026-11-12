# Detail-First Workbench Layout Design

## Goal

Give the email detail view more usable width without removing access to navigation, the message list, or WeMail AI. Preserve manual resizing while adding an explicit compact navigation mode.

This design complements [Email Recipient Metadata Layout Design](./2026-07-29-email-recipient-metadata-layout-design.md), which moves recipient information onto a full-width second row inside the detail view.

## Layout Strategy

The wide and medium desktop workbench keeps its existing resizable pane architecture:

1. mailbox navigation;
2. message list;
3. email detail;
4. WeMail AI when docked.

Navigation, list, and AI panes keep pixel-based widths. The detail pane receives all remaining space and has a `360px` minimum width.

### Default and Minimum Widths

| Viewport | Navigation default | Navigation collapsed | List default | List minimum | AI default | AI minimum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wide | `168px` | `56px` | `340px` | `260px` | `280px` | `240px` |
| Medium | `160px` | `56px` | `300px` | `240px` | `260px` | `240px` |

Existing maximum widths remain available for users who deliberately enlarge a pane.

The narrow viewport continues using its existing responsive navigation and AI drawer behavior; the new compact navigation rail applies only to wide and medium desktop layouts.

## Collapsible Navigation

- The disclosure control lives in the navigation footer beside the user identity when expanded, following the same stable bottom-corner interaction pattern in both states.
- Expanded navigation shows its current labels, nested smart classifications, smart tags, folders, counts, and footer identity.
- Collapsed navigation becomes a `56px` icon rail.
- The icon rail keeps primary destinations and their active states available, with accessible labels and hover tooltips.
- Nested groups, secondary folder rows, text labels, and unread counts are hidden in the compact rail.
- The compose action remains available as an icon.
- In the compact rail, the footer stacks the identity avatar and disclosure control vertically.
- Clicking the footer control expands or collapses the navigation without changing the current route.
- While collapsed, the navigation pane is not manually resized; the user expands it before dragging its boundary.

## State and Persistence

- Navigation collapse state is stored independently from pane widths.
- Existing user-resized navigation, list, and AI widths remain preserved.
- New default widths apply only when no saved width exists for that viewport mode.
- Persisted widths are clamped to the new minimums and existing maximums.
- Expanding the navigation restores the last expanded width rather than replacing it with the collapsed width.

## Email Detail Metadata

The detail view uses the approved two-row message header in both `SingleMessageView` and expanded `ThreadMessage`:

1. sender on the left, with timestamp and message actions on the right;
2. recipient summary or expanded To/Cc/Bcc details across the full width below.

This prevents timestamp and action controls from narrowing long recipient lists.

## Accessibility

- The navigation collapse control is a native button with `aria-expanded`, an explicit accessible name, and a reference to the navigation pane.
- Compact navigation items keep accessible names even when visual text is hidden.
- Tooltips are supplemental and are not the only accessible label.
- Existing recipient disclosure behavior and keyboard interaction remain unchanged.

## Testing

Renderer tests will verify:

- new default and minimum list and AI widths for wide and medium modes;
- a `360px` minimum detail width;
- navigation collapses to `56px` and restores its previous expanded width;
- collapsed state persists independently from resized pane widths;
- compact navigation hides nested content while retaining primary icon destinations;
- the collapse control remains keyboard accessible and does not navigate;
- timestamps render in the sender row while recipient details occupy a separate following row;
- existing pane resizing, recipient expansion, thread isolation, and narrow drawer behavior continue to pass.

## Scope

This is a renderer-only layout change. It does not alter mailbox synchronization, message data, agent behavior, routing contracts, or server APIs.
