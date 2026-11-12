# Acceptance Report

Date: 2026-07-22
Platform: Windows development host (non-packaged test runtime)

## Deterministic large-mailbox result

Command:

```text
node --import tsx --test server/wemail/performance/LargeMailboxAcceptance.test.ts
```

Fixture and measured result:

- 5,000 messages across Inbox and Archive, with mixed read state and attachment metadata
- 859 ms metadata ingestion in the measured run
- 86,261,760 bytes RSS growth, below the provisional 200 MB first-sync budget
- maximum provider and SQLite batch: 100 messages
- maximum messages retained in the sync result: 100
- historical desktop/renderer notification events: 0
- interruption/resume test: 200 committed messages retained, restart fetched only the remaining 50

The fixture is deterministic and has no network or real mailbox dependency. Results can vary with host load; the assertions use the approved upper budgets rather than the observed point value.

## Responsiveness and safety checks

- Startup is single-flight and ordered as recent metadata → interactive → historical metadata → bodies → intelligence → watcher.
- Background work pauses on CPU, working-set growth, app-wide memory, or event-loop high water and resumes only after low-water cooldown.
- Body hydration uses serial batches of five and user-opened messages bypass the background delay.
- Intelligence recovery begins after interactive readiness, scans bounded pages, yields between pages, and starts with concurrency one.
- Renderer mail rows are virtualized; a 500-row loaded query renders fewer than 30 mail DOM rows in the default test viewport.
- Bootstrap and historical sync origins do not publish received-mail notifications. Live bursts publish one bounded aggregate.

## Environment limitations

Separate packaged-Windows runs on controlled 4 GB, 8 GB, and 16 GB hardware profiles were not available in this workspace. The thresholds therefore remain provisional. Before broad release, run the packaged health workflow on those profiles and record time-to-interactive, process working set, CPU rolling average, event-loop P95, notification count, IPC publication count, and query invalidation count.

## Reproduction

```text
npm run typecheck
npm run typecheck:server
npm run typecheck:desktop
npm run test:server
npm run test:renderer
npm run test:browser
npm run package:desktop:dir
```
