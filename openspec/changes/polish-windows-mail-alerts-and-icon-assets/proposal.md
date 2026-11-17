## Why

Windows new-mail attention now works functionally, but the visible experience is
not yet release quality. Toasts inherit generic Electron presentation, repeat
low-value account text, and do not consistently use the WeMail identity. The
current icon pipeline also scales one source drawing mechanically across every
Windows surface, which makes the mark too detailed at small sizes and allows
overlapping paths to expose seams. For IMAP servers that do not advertise IDLE,
the fixed fallback polling interval can add roughly a minute before WeMail even
discovers a delivered message.

## What Changes

- Adopt the approved subject-first Windows toast hierarchy: WeMail identity,
  subject as title, sender as supporting text, and direct read/open actions.
- Generate all Windows application imagery from one approved WeMail mark using
  Micro, Compact, Toast, and Full optical masters rather than one mechanically
  scaled SVG.
- Use the approved raised-apex W geometry and a boolean-unioned solid center so
  no white V-shaped seam can appear at any output size or DPI.
- Produce explicit per-surface assets for tray, title/settings UI, Windows
  toasts, taskbar/Explorer/installer, and taskbar count overlays.
- Keep notification content privacy-safe and fall back to generic copy when the
  user has disabled message previews.
- Remove the multi-second single-mail aggregation delay while retaining burst
  coalescing for genuinely concurrent arrivals.
- Replace the fixed non-IDLE fallback interval with bounded adaptive polling
  that is faster while the process is active and backs off when appropriate.
- Add deterministic asset validation, notification XML tests, timing tests, and
  real Windows acceptance for appearance and arrival latency.

## Capabilities

### Modified Capabilities

- `desktop-new-mail-attention`: Refines Windows toast content, activation,
  identity imagery, badge assets, optical-size rules, and privacy behavior.
- `mail-sync`: Refines fallback discovery latency when IMAP IDLE is unavailable
  without exposing synchronization progress to the user.

## Impact

- Windows icon source and generated assets, Electron build metadata, tray,
  taskbar overlay, notification XML and activation routing.
- Foreground mail watcher polling policy and live-event aggregation.
- Asset generation scripts and CI checks for ICO frames, PNG dimensions,
  transparency, visual seams, and deterministic output.
- Focused Electron tests, TypeScript checks, client build, Windows desktop
  rebuild, and real-mail acceptance.

