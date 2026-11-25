import { afterEach, describe, expect, it } from "vitest";
import { runBootstrap } from "./bootstrap-core";

afterEach(() => {
  delete (window as any).gtag;
  delete (window as any).clarity;
  delete (window as any).dataLayer;
  document.head.innerHTML = "";
});

describe("runBootstrap", () => {
  it("loads the Google tag, Clarity and the fonts", () => {
    runBootstrap(document, window);
    const srcs = Array.from(document.head.querySelectorAll("script")).map((s) => s.src);
    expect(srcs).toContain("https://www.googletagmanager.com/gtag/js?id=G-Y4Y8KMLPQ7");
    expect(srcs).toContain("https://www.clarity.ms/tag/sixp9uu263");
    expect(document.head.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toContain(
      "fonts.googleapis.com/css2",
    );
    expect(typeof (window as any).gtag).toBe("function");
  });
});
