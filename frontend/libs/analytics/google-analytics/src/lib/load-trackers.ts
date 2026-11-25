import { TAG_ID } from './tag-id.js';

export const CLARITY_ID = 'sixp9uu263';

/** Google tag (gtag.js): same script URL, dataLayer, js and config calls as the old inline snippet. */
export function loadGoogleTag(doc: Document = document, win: Window = window): void {
  const script = doc.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${TAG_ID}`;
  (doc.head ?? doc.documentElement).appendChild(script);

  const w = win as unknown as { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void };
  w.dataLayer = w.dataLayer || [];
  const dataLayer = w.dataLayer;
  // gtag.js reads the `arguments` object itself from the dataLayer; an array would be ignored.
  w.gtag = function gtag() {
    dataLayer.push(arguments);
  };
  w.gtag('js', new Date());
  w.gtag('config', TAG_ID);
}

/** Microsoft Clarity: same loader as the old inline snippet. */
export function loadClarity(doc: Document = document, win: Window = window): void {
  const w = win as unknown as Record<string, any>;
  w['clarity'] =
    w['clarity'] ||
    function () {
      (w['clarity'].q = w['clarity'].q || []).push(arguments);
    };
  const t = doc.createElement('script');
  t.async = true;
  t.src = 'https://www.clarity.ms/tag/' + CLARITY_ID;
  const first = doc.getElementsByTagName('script')[0];
  if (first && first.parentNode) first.parentNode.insertBefore(t, first);
  else (doc.head ?? doc.documentElement).appendChild(t);
}
