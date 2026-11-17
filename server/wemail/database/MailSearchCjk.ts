export const CJK_SEARCH_INDEX_VERSION = 1;

const HAN_PATTERN = /\p{Script=Han}/u;
const WORD_CHARACTER_PATTERN = /[\p{Letter}\p{Number}]/u;
const RUN_BOUNDARY_TERM = "ub";

export function containsHan(value: string): boolean {
  return HAN_PATTERN.test(value);
}

/**
 * FTS5 unicode61 treats a continuous Han sentence as one token. Encode every
 * character in a Han-containing word run as an ASCII token so phrase MATCH
 * can find Chinese fragments without scanning message bodies.
 */
export function cjkSearchTerms(value: string): string {
  const terms: string[] = [];
  let run: string[] = [];
  let runHasHan = false;

  const flush = () => {
    if (runHasHan) {
      if (terms.length > 0) terms.push(RUN_BOUNDARY_TERM);
      terms.push(...run.map((character) => `u${character.codePointAt(0)!.toString(16)}`));
    }
    run = [];
    runHasHan = false;
  };

  for (const character of value.normalize("NFKC").trim().toLowerCase()) {
    if (!WORD_CHARACTER_PATTERN.test(character)) {
      flush();
      continue;
    }
    run.push(character);
    if (HAN_PATTERN.test(character)) runHasHan = true;
  }
  flush();
  return terms.join(" ");
}
