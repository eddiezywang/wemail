export interface SpellcheckIdentity {
	displayName?: string;
	emailAddress?: string;
}

export interface SpellcheckExemptRange {
	from: number;
	to: number;
}

const IDENTITY_TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;

export function normalizeSpellcheckExemptWords(
	words: readonly string[],
): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();

	for (const value of words) {
		const word = value.trim();
		if (!word) continue;
		const key = word.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(word);
	}

	return normalized;
}

export function buildComposeSpellcheckExemptWords(
	identity: SpellcheckIdentity,
): string[] {
	const words = ["WeMail"];
	const displayName = identity.displayName?.trim();
	if (displayName) {
		words.push(...(displayName.match(IDENTITY_TOKEN_PATTERN) ?? []));
	}

	const emailAddress = identity.emailAddress?.trim();
	const atIndex = emailAddress?.indexOf("@") ?? -1;
	if (emailAddress && atIndex > 0) {
		const username = emailAddress.slice(0, atIndex).trim();
		if (username) {
			words.push(username);
			words.push(...username.split(/[._+-]+/u));
		}
	}

	return normalizeSpellcheckExemptWords(words);
}

function isBoundary(character: string | undefined): boolean {
	return character === undefined || !WORD_CHARACTER_PATTERN.test(character);
}

export function findSpellcheckExemptRanges(
	text: string,
	words: readonly string[],
): SpellcheckExemptRange[] {
	if (!text || words.length === 0) return [];
	const normalizedWords = normalizeSpellcheckExemptWords(words).sort(
		(left, right) => right.length - left.length,
	);
	if (normalizedWords.length === 0) return [];

	const lowerText = text.toLowerCase();
	const candidates: SpellcheckExemptRange[] = [];
	for (const word of normalizedWords) {
		const lowerWord = word.toLowerCase();
		let searchFrom = 0;
		while (searchFrom < lowerText.length) {
			const from = lowerText.indexOf(lowerWord, searchFrom);
			if (from < 0) break;
			const to = from + lowerWord.length;
			if (isBoundary(text[from - 1]) && isBoundary(text[to])) {
				candidates.push({ from, to });
			}
			searchFrom = Math.max(to, from + 1);
		}
	}

	candidates.sort(
		(left, right) =>
			left.from - right.from ||
			(right.to - right.from) - (left.to - left.from),
	);

	const selected: SpellcheckExemptRange[] = [];
	let coveredUntil = -1;
	for (const candidate of candidates) {
		if (candidate.from < coveredUntil) continue;
		selected.push(candidate);
		coveredUntil = candidate.to;
	}
	return selected;
}
