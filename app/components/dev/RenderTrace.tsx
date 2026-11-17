// DEV-only React Profiler wrapper for attributing render cost to layout
// boundaries (Workbench shell / list / detail / agent). In production builds
// `import.meta.env.DEV` is false, so the <Profiler> is elided and children
// pass through untouched — zero overhead.
//
// Read the console during the mail-open scenarios:
//   [render-trace] <id> <mount|update|nested-update> actual=Xms base=Yms start=Z commit=C
// `start`/`commit` share the performance.now() epoch, so they line up with the
// [performance-watchdog] long-task / unresponsive `startMs` values — match a
// long-task to the boundary that rendered during it.

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

const ENABLED = import.meta.env.DEV;
// Only surface commits that cost roughly a frame or more, plus every mount
// (mounts are the first-open signal even when individually cheap). Sub-frame
// updates would drown the signal.
const LOG_THRESHOLD_MS = 8;

/**
 * Most recent user/system action, stamped onto each [render-trace] line as
 * `cause=` so a render can be tied to the action that triggered it. Set via
 * `markAction(...)` at the action sites (focus, click, open-intent, …).
 */
let currentAction = "(boot)";

/**
 * DEV-only action marker. Logs an `[action] <label> t=<perf.now>` separator and
 * stamps `label` as the `cause` on subsequent [render-trace] lines until the
 * next action. `t` shares the performance.now() epoch, so it lines up with
 * render-trace `start`/`commit` and watchdog `startMs`.
 */
export function markAction(label: string): void {
	if (!ENABLED) return;
	currentAction = label;
	console.debug(`[action] ${label} t=${Math.round(performance.now())}`);
}

const onRender: ProfilerOnRenderCallback = (
	id,
	phase,
	actualDuration,
	baseDuration,
	startTime,
	commitTime,
) => {
	if (actualDuration < LOG_THRESHOLD_MS && phase !== "mount") return;
	console.debug(
		`[render-trace] ${id} ${phase} actual=${Math.round(actualDuration)}ms base=${Math.round(baseDuration)}ms start=${Math.round(startTime)} commit=${Math.round(commitTime)} cause=${currentAction}`,
	);
};

export function RenderTrace({ id, children }: { id: string; children: ReactNode }) {
	if (!ENABLED) return <>{children}</>;
	return (
		<Profiler id={id} onRender={onRender}>
			{children}
		</Profiler>
	);
}
