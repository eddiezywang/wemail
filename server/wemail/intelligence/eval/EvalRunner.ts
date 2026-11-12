import type {
  EvalFixtureResult,
  EvalRunReport,
  IntelligenceJobType,
} from "../../../../shared/wemail/intelligence.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../ai/LlmClient.js";

/**
 * A fake LLM adapter that returns a predetermined response.
 * Used by the eval runner to test processors deterministically.
 */
export class FakeLlmAdapter implements LlmClient {
  private readonly response: LlmResponse;

  constructor(response: LlmResponse) {
    this.response = response;
  }

  async generate(_input: LlmRequest): Promise<LlmResponse> {
    return this.response;
  }
}

/**
 * Creates a FakeLlmAdapter from a JSON string response.
 */
export function fakeLlmFromJson(json: string, inputTokens = 10, outputTokens = 5): FakeLlmAdapter {
  return new FakeLlmAdapter({
    text: json,
    finishReason: "stop",
    usage: { inputTokens, outputTokens },
  });
}

/**
 * Schema for eval fixture files.
 */
export interface EvalFixture {
  /** Unique fixture identifier. */
  fixtureId: string;
  /** The feature being tested. */
  feature: IntelligenceJobType;
  /** The expected LLM JSON response. */
  llmResponse: unknown;
  /** Token counts to simulate. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Feature-specific assertions. Each key is a violation code
   * that should NOT be present. If the assertion function returns
   * a string, that string is a violation code.
   */
  assertions: Record<string, (result: unknown) => string | null>;
  /** Whether this fixture is required (failure = non-zero exit). */
  required?: boolean;
}

/**
 * Validate a JSON result against a schema-like check.
 * Returns violation codes for any failures.
 */
function validateJsonSchema(result: unknown, feature: IntelligenceJobType): string[] {
  const violations: string[] = [];
  if (typeof result !== "object" || result === null) {
    violations.push("result-not-object");
    return violations;
  }
  const obj = result as Record<string, unknown>;
  if (obj.type !== feature) {
    violations.push(`type-mismatch:expected-${feature}-got-${obj.type}`);
  }
  return violations;
}

/**
 * Run a single fixture against a processor factory.
 */
export function runFixture(
  fixture: EvalFixture,
  processorFactory: (llmClient: LlmClient) => { handle: (job: any, ctx: any) => Promise<unknown> },
  job: any,
  ctx: any,
): EvalFixtureResult {
  const fakeLlm = fakeLlmFromJson(
    JSON.stringify(fixture.llmResponse),
    fixture.inputTokens ?? 10,
    fixture.outputTokens ?? 5,
  );
  const processor = processorFactory(fakeLlm);

  let result: unknown;
  try {
    result = processor.handle(job, ctx);
    // handle returns a Promise
    if (result instanceof Promise) {
      // We need to handle this synchronously in the runner
      // This is a design issue - let's make it work
      throw new Error("Async processor handle - use runFixtureAsync instead");
    }
  } catch (err) {
    return {
      fixtureId: fixture.fixtureId,
      feature: fixture.feature,
      status: "fail",
      violations: ["processor-threw: " + (err instanceof Error ? err.message : String(err))],
      tokenEstimate: 0,
    };
  }

  return evaluateFixtureResult(fixture, result);
}

/**
 * Run a single fixture against an async processor factory.
 */
export async function runFixtureAsync(
  fixture: EvalFixture,
  processorFactory: (llmClient: LlmClient) => { handle: (job: any, ctx: any) => Promise<unknown> },
  job: any,
  ctx: any,
): Promise<EvalFixtureResult> {
  const fakeLlm = fakeLlmFromJson(
    JSON.stringify(fixture.llmResponse),
    fixture.inputTokens ?? 10,
    fixture.outputTokens ?? 5,
  );
  const processor = processorFactory(fakeLlm);

  let result: unknown;
  try {
    result = await processor.handle(job, ctx);
  } catch (err) {
    return {
      fixtureId: fixture.fixtureId,
      feature: fixture.feature,
      status: "fail",
      violations: ["processor-threw: " + (err instanceof Error ? err.message : String(err))],
      tokenEstimate: 0,
    };
  }

  return evaluateFixtureResult(fixture, result);
}

/**
 * Evaluate a fixture result against schema and assertions.
 */
function evaluateFixtureResult(
  fixture: EvalFixture,
  result: unknown,
): EvalFixtureResult {
  const violations: string[] = [];

  // JSON schema validation
  const schemaViolations = validateJsonSchema(result, fixture.feature);
  violations.push(...schemaViolations);

  // Feature-specific assertions
  for (const [name, assertion] of Object.entries(fixture.assertions)) {
    try {
      const violation = assertion(result);
      if (violation) {
        violations.push(`${name}:${violation}`);
      }
    } catch (err) {
      violations.push(`${name}:assertion-threw:${(err as Error).message}`);
    }
  }

  // Token estimate from metadata if present
  const meta = (result as any)?._metadata;
  const tokenEstimate = meta?.tokenUsage
    ? meta.tokenUsage.inputTokens + meta.tokenUsage.outputTokens
    : (fixture.inputTokens ?? 0) + (fixture.outputTokens ?? 0);

  return {
    fixtureId: fixture.fixtureId,
    feature: fixture.feature,
    status: violations.length === 0 ? "pass" : "fail",
    violations,
    tokenEstimate,
  };
}

/**
 * Options for {@link runEvalSuite}.
 */
export interface RunEvalSuiteOptions {
  /**
   * Maximum number of fixtures running in parallel. Defaults to 4.
   * `concurrency: 1` reproduces the legacy sequential behaviour.
   * Values < 1 are clamped to 1.
   */
  concurrency?: number;
}

/**
 * Run all fixtures and produce a machine-readable report.
 *
 * Fixtures are executed against a small inline worker pool so a slow
 * processor does not stall the whole suite. The returned
 * {@link EvalRunReport.results} is sorted by `fixtureId` so two reports
 * over the same input are byte-for-byte comparable regardless of which
 * promise resolved first.
 */
export async function runEvalSuite(
  fixtures: EvalFixture[],
  processorFactory: (llmClient: LlmClient, feature: IntelligenceJobType) => { handle: (job: any, ctx: any) => Promise<unknown> },
  makeJob: (feature: IntelligenceJobType) => any,
  makeCtx: () => any,
  options?: RunEvalSuiteOptions,
): Promise<EvalRunReport> {
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? 4));
  const queue = [...fixtures];
  const results: EvalFixtureResult[] = [];
  const inFlight = new Set<Promise<void>>();

  while (queue.length > 0 || inFlight.size > 0) {
    while (inFlight.size < concurrency && queue.length > 0) {
      const fixture = queue.shift()!;
      const p: Promise<void> = (async () => {
        const factory = (llmClient: LlmClient) =>
          processorFactory(llmClient, fixture.feature);
        const result = await runFixtureAsync(
          fixture,
          factory,
          makeJob(fixture.feature),
          makeCtx(),
        );
        results.push(result);
      })();
      inFlight.add(p);
      // Use void to discard the chained promise; we only care about
      // the side-effect of removing `p` from the in-flight set.
      void p.finally(() => {
        inFlight.delete(p);
      });
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  // Sort by fixtureId so the report is deterministic under concurrency.
  // Callers compare two reports for regression — ordering must not flap.
  results.sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));

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

/**
 * Check if any required fixture failed.
 */
export function hasRequiredFailures(report: EvalRunReport, fixtures: EvalFixture[]): boolean {
  return report.results.some((result) => {
    if (result.status !== "fail") return false;
    const fixture = fixtures.find((f) => f.fixtureId === result.fixtureId);
    return fixture?.required !== false; // default is required=true
  });
}
