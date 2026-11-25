import { afterEach, describe, expect, it } from "vitest";
import { resetPodWindowForTests } from "@storyteller/pod-mode";
import { runBootstrap } from "./bootstrap-core";

afterEach(() => {
  delete (window as any).gtag;
  delete (window as any).clarity;
  delete (window as any).dataLayer;
  document.head.innerHTML = "";
  resetPodWindowForTests();
  localStorage.clear();
});

describe("runBootstrap", () => {
  it("outside pod mode loads the Google tag, Clarity and the fonts, with no policy", () => {
    runBootstrap(document, window);
    const srcs = Array.from(document.head.querySelectorAll("script")).map((s) => s.src);
    expect(srcs).toContain("https://www.googletagmanager.com/gtag/js?id=G-Y4Y8KMLPQ7");
    expect(srcs).toContain("https://www.clarity.ms/tag/sixp9uu263");
    expect(document.head.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toContain(
      "fonts.googleapis.com/css2",
    );
    expect(typeof (window as any).gtag).toBe("function");
    expect(document.head.querySelector("meta[http-equiv]")).toBeNull();
  });

  it("in pod mode inserts the policy first and loads nothing third-party", () => {
    localStorage.setItem("artcraft.podMode", "1");
    runBootstrap(document, window);
    expect(document.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(document.head.querySelectorAll("script, link")).toHaveLength(0);
    expect((window as any).gtag).toBeUndefined();
    expect((window as any).clarity).toBeUndefined();
  });

  it("decides once: a flag set after the first run does not change a later run", () => {
    runBootstrap(document, window);
    localStorage.setItem("artcraft.podMode", "1");
    document.head.innerHTML = "";
    runBootstrap(document, window);
    expect(document.head.querySelector("meta[http-equiv]")).toBeNull();
  });
});
