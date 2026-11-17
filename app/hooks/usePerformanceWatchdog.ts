import { useEffect } from "react";
import type { PerformanceDiagnosticEvent } from "../../shared/wemail/startup";

function report(event: PerformanceDiagnosticEvent): void {
	console.debug("[performance-watchdog]", JSON.stringify(event));
}

export function usePerformanceWatchdog(): void {
	useEffect(() => {
		let observer: PerformanceObserver | undefined;
		if (typeof PerformanceObserver !== "undefined") {
			try {
				observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						report({
							kind: "renderer-long-task",
							observedAt: new Date().toISOString(),
							durationMs: Math.round(entry.duration),
							startMs: Math.round(entry.startTime),
						});
					}
				});
				observer.observe({ type: "longtask", buffered: true });
			} catch {
				observer = undefined;
			}
		}

		const intervalMs = 1_000;
		let expectedAt = performance.now() + intervalMs;
		const timer = window.setInterval(() => {
			const now = performance.now();
			const delay = now - expectedAt;
			const blockedSince = expectedAt;
			expectedAt = now + intervalMs;
			if (delay >= 500) {
				report({
					kind: "renderer-unresponsive",
					observedAt: new Date().toISOString(),
					durationMs: Math.round(delay),
					startMs: Math.round(blockedSince),
				});
			}
		}, intervalMs);
		return () => {
			observer?.disconnect();
			window.clearInterval(timer);
		};
	}, []);
}
