import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { rewriteTypeIndexRegex, TYPE_INDEX_LWS, TYPE_INDEX_PATTERN, typeIndexRegexFix } from "./type-index-regex-fix";

const installed = () => {
  const entry = createRequire(import.meta.url).resolve("@jeswr/pod-type-index");
  return readFileSync(entry.replace(/[^/]*$/, "lws.js"), "utf8");
};

describe("the type index regex rewrite", () => {
  it("replaces the installed package's literal with a RegExp of the same source and flags", () => {
    const original = installed();
    const rewritten = rewriteTypeIndexRegex(original);
    expect(rewritten).not.toContain(TYPE_INDEX_PATTERN);
    const [, source, flags] = /new RegExp\(("(?:[^"\\]|\\.)*"), "(\w+)"\)/.exec(rewritten) ?? [];
    expect(flags).toBe("iu");
    const literal = TYPE_INDEX_PATTERN.slice(1, TYPE_INDEX_PATTERN.lastIndexOf("/"));
    expect(new RegExp(JSON.parse(source), flags).source).toBe(new RegExp(literal, "iu").source);
    expect(new RegExp(JSON.parse(source), flags).test("https://example.org/Type")).toBe(true);
    expect(new RegExp(JSON.parse(source), flags).test("not an iri")).toBe(false);
  });

  it("fails the build when the text is not there exactly once, naming what changed", () => {
    expect(() => rewriteTypeIndexRegex("export const nothing = 1;")).toThrow(/found 0/);
    expect(() => rewriteTypeIndexRegex(`${TYPE_INDEX_PATTERN};${TYPE_INDEX_PATTERN}`)).toThrow(/found 2/);
  });

  it("touches only that module", () => {
    const plugin = typeIndexRegexFix() as { transform: (code: string, id: string) => unknown };
    expect(plugin.transform("anything", "/node_modules/other/index.js")).toBeNull();
    expect(() => plugin.transform("changed", `/x${TYPE_INDEX_LWS}`)).toThrow(/found 0/);
    expect(plugin.transform(installed(), `/x${TYPE_INDEX_LWS}`)).toMatchObject({ code: expect.stringContaining("new RegExp(") });
  });
});
