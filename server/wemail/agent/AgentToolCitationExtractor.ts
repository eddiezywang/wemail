import type { WemailAgentCitation } from "../../../shared/wemail/agentProtocol.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extract only host-verifiable identifiers from tool output. Deliberately
 * ignores Markdown links and free-form model citation claims.
 */
export function extractToolCitations(
  toolName: string,
  output: unknown,
): WemailAgentCitation[] {
  const citations = new Map<string, WemailAgentCitation>();
  const addMail = (emailId: string, label?: string, excerpt?: string) => {
    const key = `mail:${emailId}`;
    citations.set(key, { id: key, source: { kind: "mail", emailId, label, excerpt } });
  };
  const addAttachment = (attachmentId: string, label?: string) => {
    const key = `attachment:${attachmentId}`;
    citations.set(key, { id: key, source: { kind: "attachment", attachmentId, label } });
  };
  const addRecord = (recordType: string, recordId: string, label?: string) => {
    const key = `record:${recordType}:${recordId}`;
    citations.set(key, { id: key, source: { kind: "record", recordType, recordId, label } });
  };

  const visit = (value: unknown, key?: string, depth = 0) => {
    if (depth > 5 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((item) => visit(item, key, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    const emailId = text(record.emailId);
    const attachmentId = text(record.attachmentId);
    const recordType = text(record.recordType);
    const recordId = text(record.recordId);
    const label = text(record.subject) ?? text(record.filename) ?? text(record.label);
    const excerpt = text(record.snippet) ?? text(record.excerpt);
    if (emailId) addMail(emailId, attachmentId ? text(record.subject) : label, excerpt);
    if (attachmentId) addAttachment(attachmentId, label);
    if (recordType && recordId) addRecord(recordType, recordId, label);

    // Mail list/read tools conventionally return `{ messages: [{ id }] }`
    // or `{ emails: [{ id }] }`; a bare `id` elsewhere is intentionally ignored.
    if ((key === "messages" || key === "emails" || key === "message" || key === "email") && text(record.id)) {
      addMail(text(record.id)!, label, excerpt);
    }
    for (const [childKey, child] of Object.entries(record)) {
      visit(child, childKey, depth + 1);
    }
  };

  visit(output);
  return [...citations.values()].map((citation, index) => ({
    ...citation,
    id: `tool:${toolName}:${index}:${citation.id}`,
  }));
}
