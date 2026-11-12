# Mail Sidebar Collapsible Groups Design

## Goal

Make the secondary navigation under “所有邮件” easier to scan by clearly separating system intelligence, user-created intelligence, and mailbox-native folders. Each section can be collapsed independently without changing the current route.

## Information Architecture

The expanded “所有邮件” area contains three ordered groups:

1. **智能分类** — built-in automatic classifications: 重要、待处理、发票.
2. **我的智能标签** — labels created and managed by the user.
3. **邮箱文件夹** — folders synchronized from the mailbox account, including folders exposed by IMAP.

“邮箱文件夹” is intentionally user-facing and provider-neutral. The UI does not expose the transport term “IMAP”.

## Interaction

- Each group heading is a full-width button with its icon and title aligned on the left and its caret fixed on the far right.
- Clicking a heading toggles only that group’s children and does not navigate.
- All three groups are expanded initially.
- The existing “所有邮件” caret remains the parent-level control and hides or shows all groups together.
- A child group’s expanded state is retained while the parent “所有邮件” group is collapsed and reopened during the current render session.
- “我的智能标签” keeps its “创建智能标签” action inside the collapsible content.
- The “邮箱文件夹” heading remains visible even when the account has no custom folders, preserving a stable information hierarchy.

## Visual Treatment

- **智能分类:** coral system icon and the existing system-category active treatment.
- **我的智能标签:** blue-gray tag icon and blue-gray active treatment distinguish user-owned rules from built-in classifications without an additional text badge.
- **邮箱文件夹:** neutral gray folder icon and the existing neutral folder-link treatment.
- Group headings stay on one line and share the same compact typography, caret motion, hover target, and spacing.
- Headings do not use trailing divider lines, badges, or other secondary elements that compete for width in the narrow sidebar.

## Accessibility

- Headings use native `button` elements.
- Each button exposes an accessible name and `aria-expanded` state.
- Each button references its controlled content with `aria-controls`.
- Collapsed content is removed from the rendered navigation rather than only visually hidden.

## Testing

Renderer tests will verify:

- all three single-line headings render with their caret controls on the right;
- “邮箱文件夹” labels the mailbox-native folder group;
- each group collapses and expands independently;
- collapsing one group leaves the other two visible;
- the parent “所有邮件” toggle continues to hide and restore the complete secondary navigation;
- folder, category, smart-tag, create, and manage actions remain in their correct groups.

## Scope

This change affects renderer-side navigation presentation and local component state only. It does not change folder synchronization, smart-tag persistence, routing contracts, or server APIs.
