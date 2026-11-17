/**
 * Search eval fixtures for semantic search QA.
 *
 * 20+ fixtures covering:
 *  - Account-isolated semantic search
 *  - Cited QA answers
 *  - Lexical fallback
 *  - No-evidence results
 *  - Cross-account isolation
 */

import type { SearchEvalFixture } from "../SearchEval.js";

export const searchFixtures: SearchEvalFixture[] = [
  // --- Semantic search fixtures (10) ---
  {
    fixtureId: "search-q3-review",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "Q3 review meeting",
    expectMatches: true,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-project-deadline",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "project deadline",
    expectMatches: true,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-budget-numbers",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "budget numbers",
    expectMatches: true,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-vacation-request",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "vacation request",
    expectMatches: true,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-quantum-physics",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "quantum physics dark matter",
    expectMatches: false,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-empty-query-account",
    feature: "semantic-search",
    accountId: "acct-2",
    query: "Q3 review meeting",
    expectMatches: false,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-lexical-fallback",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "meeting",
    expectLexicalFallback: true,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-multiterm-query",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "sales deck Friday",
    expectMatches: true,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "search-no-results-unrelated",
    feature: "semantic-search",
    accountId: "acct-1",
    query: "underwater basket weaving",
    expectMatches: false,
  },
  {
    fixtureId: "search-isolation-acct2",
    feature: "semantic-search",
    accountId: "acct-2",
    query: "private data",
    expectMatches: false,
    requiredChecks: ["account-isolation"],
  },

  // --- Mail QA fixtures (10+) ---
  {
    fixtureId: "qa-q3-schedule",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "When is the Q3 review meeting?",
    expectHasEvidence: true,
    expectCitations: true,
    requiredChecks: ["claim-citations", "account-isolation"],
  },
  {
    fixtureId: "qa-preparation-tasks",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "What do I need to prepare for the review?",
    expectHasEvidence: true,
    expectCitations: true,
    requiredChecks: ["claim-citations", "account-isolation"],
  },
  {
    fixtureId: "qa-no-evidence-quantum",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "What are the latest quantum computing breakthroughs?",
    expectHasEvidence: false,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "qa-isolation-acct2",
    feature: "mail-qa",
    accountId: "acct-2",
    query: "What did my boss say about Q3?",
    expectHasEvidence: false,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "qa-citation-required",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "Tell me about the project update",
    expectHasEvidence: true,
    expectCitations: true,
    requiredChecks: ["claim-citations"],
  },
  {
    fixtureId: "qa-sales-numbers",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "What are the sales numbers?",
    expectHasEvidence: true,
    expectCitations: true,
    requiredChecks: ["claim-citations"],
  },
  {
    fixtureId: "qa-vacation-details",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "What are the details of the vacation request?",
    expectHasEvidence: true,
    expectCitations: true,
    requiredChecks: ["claim-citations"],
  },
  {
    fixtureId: "qa-no-evidence-ancient-history",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "Who was the Roman emperor in 100 AD?",
    expectHasEvidence: false,
  },
  {
    fixtureId: "qa-empty-account",
    feature: "mail-qa",
    accountId: "acct-3",
    query: "What emails do I have?",
    expectHasEvidence: false,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "qa-cross-account-isolation",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "Tell me about private data from account 2",
    expectHasEvidence: false,
    requiredChecks: ["account-isolation"],
  },
  {
    fixtureId: "qa-budget-information",
    feature: "mail-qa",
    accountId: "acct-1",
    query: "What information is available about the budget?",
    expectHasEvidence: true,
    expectCitations: true,
    requiredChecks: ["claim-citations"],
  },
];
