export interface ComposeAiBodyParts {
	editableHtml: string;
	protectedHtml: string;
}

const PROTECTED_REGION_PATTERNS = [
	/<div\b[^>]*\bdata-wemail-signature=["']true["'][^>]*>/i,
	/<div\b[^>]*\bdata-wemail-forwarded-message=["']true["'][^>]*>/i,
	/(?:<br\s*\/?>)?<blockquote\b[^>]*\bdata-wemail-quoted-reply=["']true["'][^>]*>/i,
	/(?:<br\s*\/?>)?<blockquote\b[^>]*>/i,
];

export function splitComposeAiBody(html: string): ComposeAiBodyParts {
	let protectedStart = -1;
	for (const pattern of PROTECTED_REGION_PATTERNS) {
		const match = pattern.exec(html);
		if (match && (protectedStart === -1 || match.index < protectedStart)) {
			protectedStart = match.index;
		}
	}

	if (protectedStart === -1) {
		return { editableHtml: html, protectedHtml: "" };
	}

	return {
		editableHtml: html.slice(0, protectedStart),
		protectedHtml: html.slice(protectedStart),
	};
}

export function mergeComposeAiBody(
	generatedHtml: string,
	protectedHtml: string,
): string {
	return `${generatedHtml}${protectedHtml}`;
}

export function hasEditableComposeContent(html: string): boolean {
	const { editableHtml } = splitComposeAiBody(html);
	return editableHtml
		.replace(/<br\s*\/?>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;|&#160;/gi, " ")
		.trim().length > 0;
}
