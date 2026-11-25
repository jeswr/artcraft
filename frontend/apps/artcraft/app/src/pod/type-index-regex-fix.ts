import type { Plugin } from "vite";

/**
 * `@jeswr/pod-type-index` ships a regex literal that rollup prints right after a
 * `for await (...)` header. Vite's import-analysis lexer reads that slash as a division and
 * aborts the build with a parse error. A `RegExp` constructor expresses the same pattern.
 * Remove this when the package changes the literal (hoist it to a constant).
 */
export const TYPE_INDEX_LWS = "/@jeswr/pod-type-index/dist/lws.js";
export const TYPE_INDEX_PATTERN = "/^[a-z][a-z0-9+.-]*:[^\\s\\p{Cc}<>\"{}|^`\\\\]+$/iu";

/**
 * Rewrites the literal to a `RegExp` with the same source and flags. Throws unless the text
 * is there exactly once, so a package change cannot leave the build either silently patched
 * wrongly or failing later in an unrelated-looking way.
 */
export function rewriteTypeIndexRegex(code: string): string {
  const found = code.split(TYPE_INDEX_PATTERN).length - 1;
  if (found !== 1) {
    throw new Error(
      `pod-type-index-regex-fix: expected the type index's identifier pattern exactly once in @jeswr/pod-type-index/dist/lws.js, found ${found}. ` +
        "The package changed: check whether this plugin is still needed and update or remove it.",
    );
  }
  const source = TYPE_INDEX_PATTERN.slice(1, -3);
  // A function replacer, so no `$` in the pattern is read as a replacement sequence.
  return code.replace(TYPE_INDEX_PATTERN, () => `new RegExp(${JSON.stringify(source)}, "iu")`);
}

export const typeIndexRegexFix = (): Plugin => ({
  name: "pod-type-index-regex-fix",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes(TYPE_INDEX_LWS)) return null;
    return { code: rewriteTypeIndexRegex(code), map: null };
  },
});
