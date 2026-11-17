import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { createPortal } from "react-dom";
import { useUIStore } from "~/hooks/useUIStore";

export default function FloatingAiLauncher() {
	const isAgentPanelOpen = useUIStore((state) => state.isAgentPanelOpen);
	const toggleAgentPanel = useUIStore((state) => state.toggleAgentPanel);

	if (isAgentPanelOpen || typeof document === "undefined") {
		return null;
	}

	return createPortal(
		<button
			type="button"
			aria-label="打开 WeMail AI"
			title="打开 WeMail AI"
			className="fixed right-4 top-[46px] z-40 inline-flex h-10 w-10 select-none items-center justify-center rounded-[10px] bg-paper-2 text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink active:bg-edge-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
			data-testid="floating-ai-launcher"
			onClick={toggleAgentPanel}
		>
			<SparkleIcon size={20} weight="fill" aria-hidden="true" />
		</button>,
		document.body,
	);
}
