import type { TodoExtractionResult } from "../../../shared/wemail/intelligence.js";
import type { TodoRepository } from "./TodoRepository.js";

export type SuggestedTodos = TodoExtractionResult["todos"];

export function persistSuggestedTodos(
  repository: Pick<TodoRepository, "isSuppressed" | "upsertSuggested">,
  accountId: string,
  emailId: string,
  todos: SuggestedTodos,
): SuggestedTodos {
  return todos.filter((todo) =>
    !repository.isSuppressed(emailId, accountId, todo.title, todo.dueDate),
  ).map((todo) => {
    const saved = repository.upsertSuggested({
      emailId, accountId, title: todo.title, description: todo.description,
      dueDate: todo.dueDate, startTime: todo.startTime, source: "ai",
      evidence: todo.evidence, extractionReason: todo.extractionReason,
      extractionConfidence: todo.confidence,
    });
    return { ...todo, status: "suggested", id: saved.id };
  });
}
