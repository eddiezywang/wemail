import { Node, mergeAttributes } from "@tiptap/core";
import {
	NodeViewContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { useState } from "react";

function ForwardedMessageView() {
	const [expanded, setExpanded] = useState(false);

	return (
		<NodeViewWrapper
			data-wemail-forwarded-message="true"
			className="my-2"
		>
			<button
				type="button"
				contentEditable={false}
				aria-expanded={expanded}
				aria-label={expanded ? "收起转发的邮件内容" : "展开转发的邮件内容"}
				title={expanded ? "收起转发的邮件内容" : "展开转发的邮件内容"}
				onClick={() => setExpanded((current) => !current)}
				className="inline-flex h-6 min-w-7 items-center justify-center rounded-[var(--radius-pill)] border border-edge bg-paper-2 px-1.5 text-ink-3 transition-colors hover:border-edge-2 hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<DotsThreeIcon size={14} weight="bold" />
			</button>
			<NodeViewContent
				className={expanded ? "mt-3 border-t border-edge-3 pt-3" : "hidden"}
			/>
		</NodeViewWrapper>
	);
}

export const ForwardedMessage = Node.create({
	name: "forwardedMessage",
	group: "block",
	content: "block+",
	defining: true,
	isolating: true,

	addAttributes() {
		return {
			"data-wemail-forwarded-message": {
				default: "true",
			},
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-wemail-forwarded-message="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-wemail-forwarded-message": "true",
			}),
			0,
		];
	},

	addNodeView() {
		return ReactNodeViewRenderer(ForwardedMessageView);
	},
});
