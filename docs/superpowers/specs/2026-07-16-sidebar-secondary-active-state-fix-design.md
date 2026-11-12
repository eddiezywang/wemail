# Sidebar Secondary Active State Fix

## Problem

System-category links share the pathname `/folder/all-mail` and differ only by the `category` query parameter. React Router's default `NavLink` active state ignores that distinction, so every system category and the `All Mail` parent appear selected together.

The current selected style also uses a continuous opaque background. When several rows are incorrectly active, it becomes a large grey block and obscures the navigation hierarchy.

## Confirmed Behavior

- Exactly one secondary navigation item may be selected at a time.
- A system category is active only when the current pathname is `/folder/all-mail` and the `category` query parameter equals its id.
- The `All Mail` parent is active only on `/folder/all-mail` without a category or tag filter.
- Smart tags are active only when their encoded tag-id pathname matches exactly.
- IMAP folders are active only when their encoded folder pathname matches exactly.
- Browser refresh, deep links, and forward/back navigation derive selection from the URL rather than component-local state.

## Visual Treatment

The selected secondary item uses a restrained editorial marker consistent with WeMail's coral accent:

- `bg-coral/5` as a very light surface tint;
- a short 2px coral rail in the existing hierarchy gutter;
- `text-ink` for the label and `text-coral` for the icon and unread count;
- no shadow, heavy border, or saturated full-row fill.

Unselected rows retain the existing quiet text and hover treatment. The parent remains expanded while a child is selected, but is not highlighted at the same time.

## Testing

- Selecting one category activates only that category.
- The `All Mail` parent is inactive when a category query is present.
- Different category query values update the active row.
- Smart-tag and custom-folder active states remain exact.
- The selected row contains the light tint and coral rail classes and does not use the former `bg-paper-4` active fill.
