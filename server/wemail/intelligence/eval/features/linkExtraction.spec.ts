import type { MailSampleEntry } from "../../../testing/mailSamples.js";

import {
  LINK_SELECTION_SYSTEM_PROMPT,
  LINK_SELECTION_JSON_SCHEMA,
  buildLinkSelectionUserMessage,
} from "../../../ai/prompts/linkExtractionPrompt.js";
import { LINK_EXTRACTION_PROCESSOR_VERSION } from "../../processors/LinkExtractionProcessor.js";
import { parseJsonWithFallbacks } from "../FeatureSpec.js";
import { defineSingleTurnSpec, type SingleTurnPromptSpec } from "../SingleTurnPromptSpec.js";
import { scoreFormat, scoreAccuracy, scoreSafety } from "../scoring/RuleScorer.js";

const QUALITY_RUBRIC =
  "Quality means: the surfaced links are genuine actions (RSVP, approve, view ticket); actionText reads like a button label; categories match (meeting/approval/document/other); marketing/unsubscribe links are not promoted to prime spots.";

interface EvalLinkCandidate {
  index: number;
  url: string;
  actionText: string;
  category: string;
}

/**
 * Lightweight URL candidate extractor. Mirrors production
 * `extractTextLinks` / `extractHtmlLinks` shape minus normalization /
 * risk scoring — eval cares only about how the LLM picks from the
 * same candidate pool every time.
 */
function extractLinkCandidates(sample: MailSampleEntry): EvalLinkCandidate[] {
  const out: Array<{ url: string; actionText: string }> = [];
  const html = sample.mail.bodyHtml;
  if (html) {
    for (const m of html.matchAll(
      /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const url = m[1];
      const label = m[2]
        ?.replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (url && /^https?:\/\//i.test(url)) {
        out.push({
          url,
          actionText: (label && label.length > 0 ? label : url).slice(0, 120),
        });
      }
    }
  }
  const text = sample.mail.bodyText;
  if (text) {
    for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
      const url = m[0];
      if (!out.some((c) => c.url === url)) out.push({ url, actionText: url });
    }
  }
  return out.slice(0, 10).map((c, i) => ({
    index: i,
    url: c.url,
    actionText: c.actionText,
    category: "navigate",
  }));
}

export const linkExtractionSpec: SingleTurnPromptSpec = defineSingleTurnSpec<unknown>({
  kind: "single-turn",
  id: "linkExtraction",
  description: "Pick the highest-value action links from a mail.",
  promptVersion: String(LINK_EXTRACTION_PROCESSOR_VERSION),
  systemPrompt: LINK_SELECTION_SYSTEM_PROMPT,
  jsonSchema: LINK_SELECTION_JSON_SCHEMA,

  buildUserMessage(sample) {
    const candidates = extractLinkCandidates(sample);
    return buildLinkSelectionUserMessage(candidates);
  },

  parseOutput(raw) {
    const parsed = parseJsonWithFallbacks(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, reason: raw.length === 0 ? "empty" : "unparseable-json" };
    }
    return { ok: true, data: parsed };
  },

  scoring: {
    format: (parsed, raw) => scoreFormat("linkExtraction", parsed, raw),
    accuracy: (parsed, sample) => scoreAccuracy("linkExtraction", parsed, sample),
    safety: (parsed, raw, sample) => scoreSafety("linkExtraction", parsed ?? null, raw, sample),
    qualityRubric: QUALITY_RUBRIC,
  },
});
