/**
 * Feishu Card JSON 2.0 for a streaming reply: a `progress` markdown element and
 * an `answer` markdown element, both updated via Card Kit streaming-text. The
 * card is created in `streaming_mode` so element text updates render with a
 * typewriter effect and are exempt from the card QPS limit.
 *
 * Extracted as a pure builder so it is unit-testable (serialization + structure)
 * and shared with bot-core.
 */
export function buildFeishuStreamingCardJson(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        { tag: "markdown", element_id: "progress", content: "" },
        { tag: "markdown", element_id: "answer", content: "" },
      ],
    },
  };
}
