import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BOOTSTRAP_SRC = "/pod-bootstrap.js";

/** Elements of <head> that come before the bootstrap script (all of them if it is absent). */
function elementsBeforeBootstrap(html: string): Element[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: Element[] = [];
  for (const el of Array.from(doc.head.children)) {
    if (el.getAttribute("src") === BOOTSTRAP_SRC) return out;
    out.push(el);
  }
  return doc.head.children.length ? Array.from(doc.head.children) : out;
}

const source = readFileSync(resolve(__dirname, "../index.html"), "utf8");

describe("index.html bootstrap order", () => {
  it("nothing precedes the bootstrap script in <head>", () => {
    expect(elementsBeforeBootstrap(source).map((e) => e.outerHTML)).toEqual([]);
  });

  it("the bootstrap is a synchronous classic script", () => {
    const doc = new DOMParser().parseFromString(source, "text/html");
    const first = doc.head.firstElementChild as HTMLScriptElement;
    expect(first.tagName).toBe("SCRIPT");
    expect(first.getAttribute("src")).toBe(BOOTSTRAP_SRC);
    for (const attr of ["type", "async", "defer", "crossorigin"]) {
      expect(first.hasAttribute(attr)).toBe(false);
    }
  });

  it("has no third-party tag or font link left in the static markup", () => {
    expect(source).not.toMatch(/googletagmanager|clarity\.ms|fonts\.googleapis|fonts\.gstatic/);
  });

  it("the check fails when something script-like or an external link comes first", () => {
    const withScript = source.replace("<head>", '<head><script type="module" src="/x.js"></script>');
    const withLink = source.replace("<head>", '<head><link rel="stylesheet" href="https://x.example/a.css">');
    expect(elementsBeforeBootstrap(withScript)).toHaveLength(1);
    expect(elementsBeforeBootstrap(withLink)).toHaveLength(1);
  });
});
