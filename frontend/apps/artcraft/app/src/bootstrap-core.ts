import { loadClarity, loadGoogleTag } from "@storyteller/google-analytics";
import { applyPodModePolicy, latchPodWindow } from "@storyteller/pod-mode";

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@300..800&display=swap";

/** Third-party font links that used to be static tags in index.html. */
export function loadHostedFonts(doc: Document = document): void {
  const head = doc.head;
  const preconnect = (href: string, crossOrigin: boolean) => {
    const link = doc.createElement("link");
    link.rel = "preconnect";
    link.href = href;
    if (crossOrigin) link.crossOrigin = "";
    head.appendChild(link);
  };
  preconnect("https://fonts.googleapis.com", false);
  preconnect("https://fonts.gstatic.com", true);
  const sheet = doc.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = FONTS_HREF;
  head.appendChild(sheet);
}

/**
 * Decide pod mode once for this window. A pod window gets the narrowing CSP and loads nothing
 * third-party (no analytics, no Google Fonts: the UI falls back to system fonts); any other
 * window loads the hosted tags as before.
 */
export function runBootstrap(doc: Document = document, win: Window = window): void {
  latchPodWindow();
  if (applyPodModePolicy(doc)) return;
  loadGoogleTag(doc, win);
  loadClarity(doc, win);
  loadHostedFonts(doc);
}
