import { WEMAIL_MCP_PROTOCOL_VERSIONS } from "../../../../shared/wemail/mcp.js";

export type McpHostFlavor = "codex" | "claude-desktop";

export class HermeticMcpClient {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    readonly endpoint: string,
    private readonly token: string,
    readonly host: McpHostFlavor = "codex",
  ) {}

  configuration() {
    const connection = {
      type: "streamablehttp",
      url: this.endpoint,
      headers: { Authorization: `Bearer ${this.token}` },
    };
    return this.host === "codex"
      ? { "wemail-mail-mcp": connection }
      : { mcpServers: { "wemail-mail-mcp": connection } };
  }

  async initialize(protocolVersion = WEMAIL_MCP_PROTOCOL_VERSIONS[0]) {
    const response = await this.request("initialize", { protocolVersion }, false);
    this.sessionId = response.headers.get("mcp-session-id") ?? undefined;
    if (response.ok && this.sessionId) {
      await this.notify("notifications/initialized");
    }
    return this.json(response);
  }

  async listTools() {
    return this.rpc("tools/list");
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return this.rpc("tools/call", { name, arguments: args });
  }

  async notify(method: string, params?: Record<string, unknown>) {
    return this.request(method, params, true);
  }

  async closeSession() {
    return fetch(this.endpoint, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  async raw(body: unknown) {
    return fetch(this.endpoint, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async rpc(method: string, params?: Record<string, unknown>) {
    return this.json(await this.request(method, params, false));
  }

  private request(method: string, params: Record<string, unknown> | undefined, notification: boolean) {
    return this.raw({
      jsonrpc: "2.0",
      ...(!notification ? { id: this.nextId++ } : {}),
      method,
      ...(params ? { params } : {}),
    });
  }

  private headers() {
    return {
      authorization: `Bearer ${this.token}`,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  private async json(response: Response) {
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) as any : undefined };
  }
}
