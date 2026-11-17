# Pi Web UI and WeMail comparison demo

## Goal

Create a self-contained browser demo that explains what `pi-web-ui` provides
and compares its general-purpose agent workspace with WeMail's mail-focused AI
panel. The demo should help decide which interaction patterns are worth
borrowing without implying that `pi-web-ui` can be dropped into the existing
React application unchanged.

## Chosen approach

The demo will be a high-fidelity conceptual reproduction implemented as a
standalone HTML, CSS, and JavaScript file. It will not install or import the
published `pi-web-ui` package.

Alternatives considered:

1. Install the real `pi-web-ui` package and run its example application. This
   would demonstrate the actual components, but it would add Lit, Tailwind,
   storage, and older Pi dependencies to the repository and would not show how
   those components relate to WeMail.
2. Use screenshots from the upstream project. This would be low effort but
   would not demonstrate streaming, tool execution, artifacts, or the product
   trade-offs interactively.
3. Build an interactive comparison that reproduces the important upstream
   concepts without adding dependencies. This keeps the experiment isolated,
   allows both designs to use the same mail-summary scenario, and makes the
   architectural differences visible. This is the selected approach.

## Scope

The demo will be written to
`design-mockups/pi-web-ui-comparison-demo.html` and will open directly from the
local filesystem in a modern desktop browser.

It will contain two switchable views:

- **Pi Web UI form**: a general-purpose agent workspace with session history,
  model and thinking controls, attachment support, streaming messages, tool
  cards, usage information, and an artifact preview panel.
- **WeMail adaptation**: the current mail workbench and approved AI response
  treatment, augmented only with selected Pi-inspired concepts such as compact
  tool status and run metadata.

Both views will run the same fictional task: summarizing recent mail by urgency
and pending action. This keeps the comparison focused on interaction and
information architecture instead of output quality.

The demo will not call the WeMail API, an LLM provider, or the actual Pi runtime.
It will not modify the production React application or its dependencies.

## Interaction design

The top comparison bar will provide:

- a segmented control for switching between the Pi and WeMail forms;
- a replay control that resets and animates the task lifecycle;
- a short label identifying the page as a conceptual reproduction.

Replay will progress through these stages:

1. User prompt is submitted.
2. Reasoning begins and updates in place.
3. Mail-search and mail-read tool cards enter running and completed states.
4. A structured Markdown-style answer streams into the conversation.
5. In the Pi view, a mail-priority artifact becomes available and opens in the
   artifact panel.
6. Usage and completion metadata settle into their final state.

The Pi view will expose more controls and general-purpose affordances. The
WeMail view will intentionally remain quieter and task-specific. Small callouts
will identify capabilities that are native concepts in `pi-web-ui` and patterns
that WeMail could selectively adopt.

## Visual direction

The two views should feel related but clearly distinct:

- The Pi form uses a neutral, technical workspace aesthetic with a session rail,
  dense controls, restrained blue accents, compact tool cards, and an optional
  artifact split pane.
- The WeMail form preserves the warm paper background, coral accent, generous
  document typography, mail navigation, and the approved collapsed activity
  treatment.

The page should avoid presenting either view as universally superior. The
comparison should communicate that Pi offers a broad agent application shell,
while WeMail benefits from a narrower mail-oriented experience.

## Component model

The standalone page will be organized into small conceptual sections:

- `ComparisonToolbar`: switches views and controls replay.
- `PiWorkspace`: session rail, `AgentInterface`, composer, and artifact panel.
- `WeMailWorkspace`: mailbox shell and the current WeMail AI panel treatment.
- `RunTimeline`: shared JavaScript state machine that drives both demonstrations.
- `CapabilityNotes`: concise annotations explaining reusable and non-reusable
  portions of the upstream design.

No external framework is required. The JavaScript state machine will only
toggle classes, update text, and reveal predefined content.

## Responsive behavior

The primary target is a desktop viewport of at least 1440 pixels. Below 1180
pixels, the artifact panel and mailbox detail area may collapse so the active
agent surface remains readable. The page must remain navigable without
horizontal scrolling at common laptop widths.

## Error and limitation handling

Because the demo is simulated, it must visibly label itself as a conceptual
reproduction rather than the upstream package running live. Replay should be
idempotent: pressing replay during an animation cancels existing timers and
starts from the initial state. Switching views should preserve the current run
stage so the same moment can be compared between layouts.

If JavaScript is disabled, both completed layouts should still be visible with
the Pi view selected by default.

## Acceptance criteria

- The file opens directly from disk without a build step or network dependency.
- The Pi view visibly demonstrates sessions, model/thinking controls,
  attachments, streaming, tool cards, usage, and artifacts.
- The WeMail view reproduces the approved reasoning-collapse and final Markdown
  hierarchy rather than reverting to raw text bubbles.
- Switching views compares the same task and run stage.
- Replay demonstrates the complete lifecycle and can safely restart.
- Labels distinguish upstream Pi concepts, reusable interaction patterns, and
  WeMail-specific product decisions.
- No application source, dependency, or runtime configuration is changed.
