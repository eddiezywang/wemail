/**
 * Deterministic pinyin port for the open-tree directory tests (P2.4).
 *
 * The real `pinyin-pro` based builder now lives in the internal edition;
 * the open snapshot engine only receives a `DirectoryPinyinPort`. Tests inject
 * this small table so pinyin search assertions stay meaningful without any
 * enterprise implementation in the open tree. All fixtures are neutral.
 */
import type { DirectoryPinyinPort } from "./DirectoryRemoteClient.js";

interface PinyinEntry {
  fullPinyin: string;
  pinyinInitials: string;
  searchTerms: string[];
}

const ENTRIES: Record<string, PinyinEntry> = {
  "张三": {
    fullPinyin: "zhangsan",
    pinyinInitials: "zs",
    searchTerms: ["zhangsan", "zhang san", "zs"],
  },
  "徐伟": {
    fullPinyin: "xuwei",
    pinyinInitials: "xw",
    searchTerms: ["xuwei", "xu wei", "xw"],
  },
  "徐自然": {
    fullPinyin: "xuziran",
    pinyinInitials: "xzr",
    searchTerms: ["xuziran", "xu zi ran", "xzr"],
  },
};

export const TEST_DIRECTORY_PINYIN: DirectoryPinyinPort = Object.freeze({
  version: 1,
  buildIndex(displayName: string) {
    const segments = displayName.match(/\p{Script=Han}+/gu) ?? [];
    const fullForms = new Set<string>();
    const initialForms = new Set<string>();
    const searchTerms = new Set<string>();
    for (const segment of segments) {
      const entry = ENTRIES[segment];
      if (!entry) continue;
      fullForms.add(entry.fullPinyin);
      initialForms.add(entry.pinyinInitials);
      for (const term of entry.searchTerms) searchTerms.add(term);
    }
    return {
      fullPinyin: Array.from(fullForms).join(" "),
      pinyinInitials: Array.from(initialForms).join(" "),
      searchTerms: Array.from(searchTerms),
    };
  },
});
