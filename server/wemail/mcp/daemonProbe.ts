/**
 * Authenticated daemon probe: an initialize handshake that only a WeMail MCP
 * listener sharing this database's tokens can answer — so a random port
 * squatter can never make the GUI attach to it. Connection refused (nothing
 * listening), non-200, wrong server name, or missing token all mean "not a
 * daemon we can attach to" and the caller should self-host instead.
 */
export interface WemailDaemonProbeOptions {
	port: number;
	/** Returns the raw bearer token to probe with; null = definitely not alive. */
	fetchToken: () => string | null;
	timeoutMs?: number;
}

export async function isWemailDaemonServing(
	options: WemailDaemonProbeOptions,
): Promise<boolean> {
	const token = options.fetchToken();
	if (!token) return false;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 1_500);
	try {
		const response = await fetch(`http://127.0.0.1:${options.port}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "wemail-daemon-probe", version: "0.0.0" },
				},
			}),
			signal: abort.signal,
		});
		if (!response.ok) return false;
		const text = await response.text();
		if (!text.startsWith("{")) return false;
		const payload = JSON.parse(text) as {
			result?: { serverInfo?: { name?: string } };
		};
		return payload.result?.serverInfo?.name === "wemail-mail-mcp";
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
