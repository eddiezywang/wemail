## Context

The existing notification and attention implementation has proved that live
mail events can drive Windows notifications, taskbar overlays, and tray badges.
The remaining issues cross three layers: notification information hierarchy,
Windows image assets, and discovery latency. Treating them as isolated tweaks
would allow the toast, taskbar, tray, and installer to drift apart again.

Runtime evidence for the reported 163.com example showed that WeMail discovered
the message through `live-poll`, not `live-idle`; the server did not advertise a
usable native IDLE path. After discovery, the existing aggregation window added
about three seconds before the toast was displayed. The larger delay occurred
before discovery and is therefore addressed in the watcher, not in Windows
notification rendering.

## Goals

- Make a new-mail toast recognizable as WeMail at a glance and useful without
  duplicating account/provider labels.
- Preserve one brand mark while adapting its geometry to each Windows optical
  size and DPI surface.
- Guarantee that generated icon artwork contains no accidental internal seam,
  including the previously observed white V inside the center fold.
- Reduce application-added notification latency for both IDLE and non-IDLE
  accounts while keeping normal background synchronization silent.
- Preserve the existing definition of the taskbar/tray number: mail received
  since the user last focused WeMail.

## Non-Goals

- Guaranteeing delivery latency imposed by the sender, SMTP relays, or the IMAP
  provider before the message becomes visible in the mailbox.
- Replacing ImapFlow or implementing a custom IMAP IDLE parser.
- Displaying synchronization progress or polling state in the normal UI.
- Reusing sender avatars as the application identity image.
- Adding macOS or Linux optical assets in this change.

## Decisions

### 1. Subject-first Windows toast

The toast uses the approved B hierarchy:

1. Windows attribution identifies the application as `WeMail` with the WeMail
   Toast asset.
2. The bold title is the bounded subject.
3. Supporting text is `来自 <display sender>` and may include one bounded safe
   preview line only when notification previews are enabled.
4. Actions are `标为已读` and `打开邮件` where the Windows template supports
   them; clicking the body performs the same open-mail activation.

Provider labels such as `(Internet Mail)`, duplicate account identity, generic
Electron branding, and dynamic sender avatars are excluded. Empty subjects use
`新邮件`; missing senders use `发件人未知`.

When privacy mode disables message previews, the toast shows `收到一封新邮件`
and the account display name without subject, sender address, body, or attachment
names. Activation arguments contain only an opaque local target identifier and
action, never message content or credentials.

### 2. One mark, four optical masters

The approved mark is an orange rounded square containing a white envelope whose
center negative-space fold reads as W. The lower-fold apex uses the approved
raised position. The center orange connection is one boolean-unioned solid
shape; it is not constructed by crossing two strokes, so no white V-shaped seam
can exist in the source geometry.

Four optical masters are maintained:

| Master | Logical sizes | Surfaces | Treatment |
| --- | --- | --- | --- |
| Micro | 16, 20px | tray and dense status UI | bold outer silhouette, simplified W, removed nonessential seams |
| Compact | 24, 32, 40px | title bar, settings, taskbar base | retained W with conservative apex and enlarged counters |
| Toast | 48px logical | Windows toast identity | approved raised W, transparent padded PNGs for DPI variants |
| Full | 48–256px | Explorer, shortcuts, installer, About | complete approved geometry and corner/shadow detail where supported |

The masters share palette, corner character, envelope proportions, and W
identity but are intentionally not scale-identical. Small assets are redrawn on
the pixel grid and are never produced by shrinking the 256px frame at runtime.

### 3. Generated Windows asset matrix

One checked-in vector source directory produces deterministic generated assets:

- tray PNGs for 16px and 20px;
- Compact PNG/SVG assets for 24px, 32px, and 40px UI use;
- Toast PNGs at 48, 96, 144, and 192 physical pixels, representing Windows DPI
  scales for the 48px logical image;
- a multi-frame ICO containing 16, 20, 24, 32, 40, 48, 64, 128, and 256px
  frames, with each frame selected from the matching optical master;
- the taskbar numeric badge as a separate transparent 32px native bitmap
  overlay composited by Windows, never baked into the base application icon.

The taskbar, Explorer, Start Menu, installer, tray, toast, title bar, and settings
screens all consume assets from this matrix. No surface may silently fall back
to Electron's generic icon when an explicit WeMail image is supported.

### 4. Asset quality gates

The generator normalizes same-color regions through boolean union before
rasterization. CI validates exact dimensions, alpha channel, ICO frame list,
deterministic hashes, and the absence of unexpected light pixels within the
orange center connection. Golden-image tests cover Micro, Toast, and Full at
100%, 125%, 150%, and 200% Windows scaling. Manual acceptance checks the mark on
both light and dark system themes.

### 5. Notification timing policy

Single-message arrivals are published immediately after durable discovery and
deduplication. The aggregator keeps only a short trailing burst window for
additional messages that arrive nearly simultaneously; it must not hold the
first single-message toast for the existing multi-second window. A burst may be
summarized as `收到 N 封新邮件`, while the attention count still records every
unique message.

Notification delivery remains downstream of the durable insert. Failures or
Windows suppression never block renderer refresh or badge projection.

### 6. Adaptive fallback when IDLE is unavailable

ImapFlow capability discovery remains authoritative. When IDLE is healthy, no
periodic fast poll competes with it. When IDLE is unavailable or repeatedly
fails, the foreground watcher uses adaptive polling:

- initial/active interval: 15 seconds while the desktop process is running and
  the account is online;
- healthy empty checks remain at 15 seconds while the desktop process and
  account are online; optional 30/60-second policy tiers are reserved for a
  future power-aware mode and are not selected merely because the mailbox is quiet;
- activity reset: focus, manual refresh, reconnect, network recovery, or a new
  message resets the interval to 15 seconds;
- failure backoff: transient errors use bounded exponential backoff with jitter
  and never busy-loop;
- only one account-scoped foreground reconciliation may run at a time, so timer,
  manual refresh, and reconnect work coalesce.

These are service defaults, not user-facing synchronization modes. Normal
polling remains silent. Diagnostics expose capability, current strategy,
interval, last attempt, last success, and bounded outcome only in the existing
diagnostics/debug surfaces.

### 7. Latency measurement

Diagnostics distinguish four timestamps when available:

- message provider/internal date (informational and not treated as arrival);
- first mailbox visibility/discovery time;
- durable local insertion time;
- Windows toast submission time.

The application latency budget begins at discovery because SMTP/provider delay
is outside WeMail's control. IDLE acceptance targets toast submission within two
seconds of discovery. Non-IDLE acceptance targets discovery within one active
poll interval plus one bounded reconciliation, and toast submission within two
seconds after discovery.

## Failure Handling

- Missing or invalid Toast assets fall back to a known WeMail generated PNG,
  not a sender avatar or remote URL.
- Unsupported toast actions degrade to body activation without suppressing the
  notification.
- Adaptive polling failures back off and preserve the last successful mailbox
  state; they do not surface routine progress.
- The badge counter remains independent from toast policy and timing.
- Asset-generation failure stops packaging rather than shipping incomplete or
  generic branding.

## Testing and Acceptance

- Unit-test toast XML escaping, subject-first hierarchy, privacy mode, action
  arguments, and fallback copy.
- Unit-test immediate single-message publishing and burst aggregation.
- Unit-test IDLE versus adaptive-poll selection, interval transitions,
  coalescing, jitter bounds, failure backoff, and stop/restart cleanup.
- Validate generated PNG/ICO assets and golden renders across optical sizes.
- Rebuild the Windows desktop app and verify tray, title/settings, taskbar,
  Explorer/installer, and toast identity images use the intended master.
- Send real mail to one IDLE-capable account and one non-IDLE account; record
  provider visibility, discovery, insertion, toast, badge update, and focus
  reset without logging message content.

## Rollout

1. Land vector masters, deterministic generation, and asset tests.
2. Wire the generated asset matrix into packaging, tray, taskbar, and toast.
3. Land subject-first notification XML and activation tests.
4. Change aggregation and adaptive fallback timing behind internal constants.
5. Run Windows build and real-account acceptance, then tune intervals only from
   bounded diagnostics evidence.

Rollback may restore the previous polling interval or toast layout without
removing the existing attention counter. Generated legacy icons remain available
for one release as a packaging fallback, but the corrected mark is the default.
