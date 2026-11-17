/**
 * Eval runner for semantic search QA.
 *
 * Loads fixtures, runs them through the search and QA services,
 * and produces a report of pass/fail results with violation codes.
 */

import type {
  EvalFixtureResult,
  EvalRunReport,
  MailQaClaim,
  MailQaResult,
  SemanticSearchResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailQaService } from "../MailQaService.js";
import type { SemanticSearchService } from "../SemanticSearchService.js";

export interface SearchEvalFixture {
  fixtureId: string;
  feature: "semantic-search" | "mail-qa";
  /** Account id to scope the search/QA. */
  accountId: string;
  /** For search: the query string. For QA: the question. */
  query: string;
  /** Expected: results should contain at least one match. */
  expectMatches?: boolean;
  /** Expected: search mode should be "lexical" (when no embedding). */
  expectLexicalFallback?: boolean;
  /** For QA: every claim should have at least one citation. */
  expectCitations?: boolean;
  /** For QA: should haveEvidence match this? */
  expectHasEvidence?: boolean;
  /** Violation codes that indicate a failure. */
  requiredChecks?: string[];
}

/**
 * Run a single search eval fixture.
 */
export async function runSearchFixture(
  fixture: SearchEvalFixture,
  searchService: SemanticSearchService,
): Promise<EvalFixtureResult> {
  const violations: string[] = [];

  try {
    const result: SemanticSearchResult = await searchService.search({
      accountId: fixture.accountId,
      query: fixture.query,
    });

    if (fixture.expectMatches === true && result.chunks.length === 0) {
      violations.push("no-matches-expected");
    }
    if (fixture.expectMatches === false && result.chunks.length > 0) {
      violations.push("unexpected-matches");
    }
    if (fixture.expectLexicalFallback && result.mode !== "lexical") {
      violations.push("not-lexical-fallback");
    }
    // Account isolation check: all chunks should belong to the account.
    for (const chunk of result.chunks) {
      // Chunk emailId should start with the accountId prefix or be
      // verifiable as belonging to the account.
      if (!chunk.emailId.includes(fixture.accountId)) {
        violations.push("account-isolation-violation");
        break;
      }
    }
  } catch (error) {
    violations.push(`search-error: ${(error as Error).message}`);
  }

  return {
    fixtureId: fixture.fixtureId,
    feature: "summary" as any, // Map to existing type; eval infrastructure uses this.
    status: violations.length === 0 ? "pass" : "fail",
    violations,
    tokenEstimate: 0,
  };
}

/**
 * Run a single QA eval fixture.
 */
export async function runQaFixture(
  fixture: SearchEvalFixture,
  qaService: MailQaService,
): Promise<EvalFixtureResult> {
  const violations: string[] = [];

  try {
    const result: MailQaResult = await qaService.answer({
      accountId: fixture.accountId,
      question: fixture.query,
    });

    if (fixture.expectHasEvidence !== undefined && result.hasEvidence !== fixture.expectHasEvidence) {
      violations.push("evidence-mismatch");
    }
    if (fixture.expectCitations && result.hasEvidence) {
      for (const claim of result.claims) {
        if (claim.citations.length === 0) {
          violations.push("claim-without-citation");
          break;
        }
      }
    }
    // Every claim with citations should reference the correct account.
    for (const claim of result.claims) {
      for (const citation of claim.citations) {
        if (!citation.emailId.includes(fixture.accountId)) {
          violations.push("account-isolation-violation");
          break;
        }
      }
      if (violations.includes("account-isolation-violation")) break;
    }
  } catch (error) {
    violations.push(`qa-error: ${(error as Error).message}`);
  }

  return {
    fixtureId: fixture.fixtureId,
    feature: "summary" as any,
    status: violations.length === 0 ? "pass" : "fail",
    violations,
    tokenEstimate: 0,
  };
}

/**
 * Run a complete eval suite of fixtures.
 */
export async function runSearchEvalSuite(
  fixtures: SearchEvalFixture[],
  searchService: SemanticSearchService,
  qaService: MailQaService,
): Promise<EvalRunReport> {
  const results: EvalFixtureResult[] = [];

  for (const fixture of fixtures) {
    const result =
      fixture.feature === "semantic-search"
        ? await runSearchFixture(fixture, searchService)
        : await runQaFixture(fixture, qaService);
    results.push(result);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;

  return {
    runAt: new Date().toISOString(),
    fixturesLoaded: fixtures.length,
    passed,
    failed,
    results,
  };
}
