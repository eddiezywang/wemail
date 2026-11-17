import { Node, mergeAttributes } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Paragraph from "@tiptap/extension-paragraph";

export const ProtectedBlockquote = Blockquote.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			"data-wemail-quoted-reply": {
				default: null,
				parseHTML: (element) =>
					element.getAttribute("data-wemail-quoted-reply"),
			},
			style: {
				default: null,
				parseHTML: (element) => element.getAttribute("style"),
			},
		};
	},
});

export const ProtectedParagraph = Paragraph.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			style: {
				default: null,
				parseHTML: () => null,
			},
		};
	},
});

export const SignatureBrand = Node.create({
	name: "signatureBrand",
	group: "block",
	content: "inline*",
	selectable: false,
	draggable: false,

	addAttributes() {
		return {
			style: {
				default: null,
				parseHTML: (element) => element.getAttribute("style"),
			},
		};
	},

	parseHTML() {
		return [{ tag: 'p[data-wemail-signature-brand="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"p",
			mergeAttributes(HTMLAttributes, {
				"data-wemail-signature-brand": "true",
			}),
			0,
		];
	},
});

export const SignatureBlock = Node.create({
	name: "signatureBlock",
	group: "block",
	content: "block+ signatureBrand",
	defining: true,
	isolating: true,

	addAttributes() {
		return {
			"data-wemail-signature": {
				default: "true",
			},
			style: {
				default: null,
				parseHTML: (element) => element.getAttribute("style"),
			},
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-wemail-signature="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-wemail-signature": "true",
			}),
			0,
		];
	},
});
