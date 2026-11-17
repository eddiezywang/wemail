import { Streamdown } from "streamdown";
import { handleExternalLinkClick } from "~/lib/external-links";

export function AgentMarkdown({
  text,
  isStreaming = false,
  className,
}: {
  text: string;
  isStreaming?: boolean;
  className?: string;
}) {
  return (
    <Streamdown
      mode={isStreaming ? "streaming" : "static"}
      className={`agent-markdown ${className ?? ""}`.trim()}
      controls={{
        code: { copy: true, download: false },
        table: false,
        mermaid: false,
      }}
      lineNumbers={false}
      components={{
        a: ({ href, children, ...props }) => (
          <a
            href={href}
            rel="noopener noreferrer"
            onClick={(event) => handleExternalLinkClick(event.nativeEvent, href)}
            {...props}
          >
            {children}
          </a>
        ),
        img: () => null,
      }}
    >
      {text}
    </Streamdown>
  );
}
