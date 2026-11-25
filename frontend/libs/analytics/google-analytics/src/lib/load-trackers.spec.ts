import { afterEach, describe, expect, it } from 'vitest';
import { latchPodWindow, resetPodWindowForTests, sessionRestoreAllowed } from '@storyteller/pod-mode';
import { loadClarity, loadGoogleTag } from './load-trackers.js';

function freshWindow() {
  const doc = document.implementation.createHTMLDocument('x');
  doc.head.appendChild(doc.createElement('script'));
  return { doc, win: {} as unknown as Window & Record<string, any> };
}

afterEach(() => {
  resetPodWindowForTests();
  localStorage.clear();
});

describe('tracker loaders (same ids and order as the old inline snippets)', () => {
  it('google tag: async script, then js and config on the dataLayer as arguments objects', () => {
    const { doc, win } = freshWindow();
    loadGoogleTag(doc, win);
    const s = doc.head.querySelectorAll('script')[1] as HTMLScriptElement;
    expect(s.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-Y4Y8KMLPQ7');
    expect(s.async).toBe(true);
    expect(win.dataLayer).toHaveLength(2);
    // gtag.js ignores arrays: entries must be `arguments` objects.
    for (const entry of win.dataLayer as unknown[]) {
      expect(Array.isArray(entry)).toBe(false);
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    }
    expect(Array.from(win.dataLayer[0] as ArrayLike<unknown>)[0]).toBe('js');
    expect(Array.from(win.dataLayer[1] as ArrayLike<unknown>)).toEqual(['config', 'G-Y4Y8KMLPQ7']);
  });

  it('google tag: leaves a working window.gtag behind for later calls', () => {
    const { doc, win } = freshWindow();
    loadGoogleTag(doc, win);
    expect(typeof win.gtag).toBe('function');
    win.gtag('event', 'x');
    expect(Array.from(win.dataLayer[2] as ArrayLike<unknown>)).toEqual(['event', 'x']);
  });

  it('clarity: async script inserted before the first script, queue works', () => {
    const { doc, win } = freshWindow();
    const first = doc.head.querySelector('script')!;
    loadClarity(doc, win);
    const t = doc.head.querySelector('script') as HTMLScriptElement;
    expect(t).not.toBe(first);
    expect(t.src).toBe('https://www.clarity.ms/tag/sixp9uu263');
    expect(t.async).toBe(true);
    win.clarity('set', 'k', 'v');
    win.clarity('event', 'e');
    expect(win.clarity.q.map((a: ArrayLike<unknown>) => Array.from(a))).toEqual([
      ['set', 'k', 'v'],
      ['event', 'e'],
    ]);
  });
});

describe('tracker loaders in a pod window', () => {
  it('do nothing and leave session restore allowed', () => {
    localStorage.setItem('artcraft.podMode', '1');
    latchPodWindow();
    const { doc, win } = freshWindow();
    loadGoogleTag(doc, win);
    loadClarity(doc, win);
    expect(doc.head.querySelectorAll('script')).toHaveLength(1);
    expect(win.gtag).toBeUndefined();
    expect(win.clarity).toBeUndefined();
    expect(sessionRestoreAllowed()).toBe(true);
  });

  it('either loader running in a non-pod window forbids session restore later', () => {
    for (const load of [loadGoogleTag, loadClarity]) {
      resetPodWindowForTests();
      load(freshWindow().doc, freshWindow().win);
      localStorage.setItem('artcraft.podMode', '1'); // flag appears later; latch is already non-pod
      expect(sessionRestoreAllowed()).toBe(false);
      localStorage.clear();
    }
  });
});
