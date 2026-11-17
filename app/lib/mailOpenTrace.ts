interface MailOpenTrace {
	messageId: string;
	traceId: string;
	intentMark: string;
	completed: boolean;
}

const traces = new Map<string, MailOpenTrace>();
const MAX_ACTIVE_TRACES = 50;

export function beginMailOpenTrace(messageId: string, restart = false): string {
	const existing = traces.get(messageId);
	if (!restart && existing && !existing.completed) return existing.traceId;
	const traceId = `mail-open-${crypto.randomUUID()}`;
	const intentMark = markName(traceId, "intent");
	performance.mark(intentMark, { detail: { traceId, stage: "intent" } });
	traces.set(messageId, { messageId, traceId, intentMark, completed: false });
	while (traces.size > MAX_ACTIVE_TRACES) {
		const oldest = traces.keys().next().value as string | undefined;
		if (!oldest) break;
		traces.delete(oldest);
	}
	return traceId;
}

export function markMailOpenStage(
	messageId: string,
	stage: string,
	traceId?: string,
): void {
	const trace = traces.get(messageId);
	if (!trace || trace.completed || (traceId && trace.traceId !== traceId)) return;
	const endMark = markName(trace.traceId, stage);
	performance.mark(endMark, { detail: { traceId: trace.traceId, stage } });
	const measure = performance.measure("wemail.mail-open", {
		start: trace.intentMark,
		end: endMark,
		detail: { traceId: trace.traceId, stage },
	});
	// Auto-print each stage's intent→stage duration so the open-latency
	// breakdown is visible in the DevTools Console (F12) without a query.
	console.debug(`[mail-open] ${trace.traceId} ${stage}: ${Math.round(measure.duration)}ms`);
	if (stage === "body-paint" || stage === "terminal-failure") {
		trace.completed = true;
	}
}

function markName(traceId: string, stage: string): string {
	return `wemail.mail-open:${traceId}:${stage}`;
}
