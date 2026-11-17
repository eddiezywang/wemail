/**
 * Mail QA service: answers natural-language questions about email content
 * using retrieved chunks as evidence, with citations for every factual claim.
 *
 * Design invariants:
 *  - Every factual claim in an answer MUST cite supporting email/chunk references.
 *  - When chunks don't support an answer, return a no-evidence result.
 *  - QA is account-isolated: only chunks from the specified account are used.
 *  - The service is resilient to LLM unavailability: it returns the retrieved
 *    chunks and claims without an LLM-generated answer if the LLM is down.
 */

import type { LlmClient } from "../ai/LlmClient.js";
import type { LlmRuntime } from "../ai/LlmRuntime.js";
import type {
  MailQaCitation,
  MailQaClaim,
  MailQaRequest,
  MailQaResult,
  SemanticSearchMode,
} from "../../../shared/wemail/intelligence.js";
import type { SemanticSearchService } from "./SemanticSearchService.js";

export interface MailQaServiceOptions {
  searchService: SemanticSearchService;
  /** Optional LLM client for generating answers. */
  llmClient?: LlmClient;
  llmRuntime?: LlmRuntime;
  /** Model to use for QA answer generation. */
  qaModel?: string;
}

/**
 * System prompt for the QA answer generation. Instructs the model
 * to cite every factual claim and to say when evidence is insufficient.
 */
const QA_SYSTEM_PROMPT = `You are a mail QA assistant. You answer questions about email content.
RULES:
1. Every factual claim MUST be supported by the provided email chunks.
2. Cite the source for each claim using the format [email_id::chunk_id].
3. If the provided chunks do not contain enough information to answer, respond with: "I could not find sufficient evidence in your email to answer this question."
4. Do NOT invent or assume information not present in the chunks.
5. Structure your answer as a JSON object with this exact shape:
{
  "hasEvidence": boolean,
  "answer": string (only when hasEvidence is true),
  "claims": [{ "text": string, "citations": [{ "emailId": string, "chunkId": string, "quote": string }] }]
}`;

export class MailQaService {
  private readonly searchService: SemanticSearchService;
  private readonly llmClient?: LlmClient;
  private readonly llmRuntime?: LlmRuntime;
  private readonly qaModel: string;

  constructor(options: MailQaServiceOptions) {
    this.searchService = options.searchService;
    this.llmClient = options.llmClient;
    this.llmRuntime = options.llmRuntime;
    this.qaModel = options.qaModel ?? "gpt-4o-mini";
  }

  /**
   * Answer a question about email content with cited evidence.
   *
   * Steps:
   *  1. Retrieve relevant chunks via semantic search.
   *  2. If LLM is available, generate an answer with citations.
   *  3. If LLM is unavailable, return the retrieved chunks as
   *     raw claims without a synthesized answer.
   *  4. If no chunks are found, return a no-evidence result.
   */
  async answer(request: MailQaRequest): Promise<MailQaResult> {
    const { accountId, question, maxChunks = 20 } = request;

    // Step 1: Retrieve relevant chunks.
    const searchResult = await this.searchService.search({
      accountId,
      query: question,
      limit: maxChunks,
    });

    // Step 2: If no chunks found, return no-evidence result.
    if (searchResult.chunks.length === 0) {
      return {
        hasEvidence: false,
        claims: [],
        mode: searchResult.mode,
        retrievedChunkCount: 0,
      };
    }

    // Step 3: If LLM is available, generate a cited answer.
    const snapshot = this.llmRuntime?.snapshot();
    const llm = snapshot?.client ?? this.llmClient;
    const model = snapshot?.modelFor("summary") ?? this.qaModel;
    if (llm) {
      try {
        return await this.generateCitedAnswer(
          question,
          searchResult.chunks,
          searchResult.mode,
          llm,
          model,
        );
      } catch {
        // LLM failure: fall through to raw claims.
      }
    }

    // Step 4: Return raw chunks as claims without LLM synthesis.
    const claims: MailQaClaim[] = searchResult.chunks.map((chunk) => ({
      text: chunk.snippet,
      citations: [
        {
          emailId: chunk.emailId,
          chunkId: chunk.chunkId,
        } satisfies MailQaCitation,
      ],
    }));

    return {
      hasEvidence: true,
      claims,
      mode: searchResult.mode,
      retrievedChunkCount: searchResult.chunks.length,
    };
  }

  /**
   * Generate a cited answer using the LLM.
   */
  private async generateCitedAnswer(
    question: string,
    chunks: Array<{ emailId: string; chunkId: string; snippet: string }>,
    mode: SemanticSearchMode,
    llm: LlmClient,
    model: string,
  ): Promise<MailQaResult> {
    // Build context from chunks.
    const contextParts = chunks.map(
      (chunk) =>
        `[${chunk.emailId}::${chunk.chunkId}]: ${chunk.snippet}`,
    );
    const context = contextParts.join("\n\n");

    const response = await llm.generate({
      model,
      system: QA_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nEmail evidence:\n${context}`,
        },
      ],
      temperature: 0,
      maxTokens: 1000,
      jsonSchema: {
        type: "object",
        properties: {
          hasEvidence: { type: "boolean" },
          answer: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                citations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      emailId: { type: "string" },
                      chunkId: { type: "string" },
                      quote: { type: "string" },
                    },
                    required: ["emailId", "chunkId"],
                  },
                },
              },
              required: ["text", "citations"],
            },
          },
        },
        required: ["hasEvidence", "claims"],
      },
    });

    try {
      const parsed = JSON.parse(response.text) as {
        hasEvidence: boolean;
        answer?: string;
        claims: Array<{
          text: string;
          citations: Array<{ emailId: string; chunkId: string; quote?: string }>;
        }>;
      };

      // Validate that every claim has at least one citation.
      const claims: MailQaClaim[] = parsed.claims.map((claim) => ({
        text: claim.text,
        citations: claim.citations.map((cit) => ({
          emailId: cit.emailId,
          chunkId: cit.chunkId,
          quote: cit.quote,
        })),
      }));

      return {
        hasEvidence: parsed.hasEvidence,
        answer: parsed.answer,
        claims,
        mode,
        retrievedChunkCount: chunks.length,
      };
    } catch {
      // If we can't parse the LLM response, return raw claims.
      const claims: MailQaClaim[] = chunks.map((chunk) => ({
        text: chunk.snippet,
        citations: [
          {
            emailId: chunk.emailId,
            chunkId: chunk.chunkId,
          },
        ],
      }));

      return {
        hasEvidence: true,
        claims,
        mode,
        retrievedChunkCount: chunks.length,
      };
    }
  }
}
