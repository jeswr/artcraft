import { afterEach, describe, expect, it, vi } from 'vitest';
import { callGtag } from './gtag-guard.js';
import { gtagEvent } from './gtag-event.js';
import { gtagLogin } from './gtag-login.js';
import { gtagLogout } from './gtag-logout.js';

afterEach(() => {
  delete (window as unknown as { gtag?: unknown }).gtag;
  vi.restoreAllMocks();
});

describe('gtag guard', () => {
  it('is a no-op for every call site when gtag is absent', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(() => {
      callGtag('event', 'x');
      gtagEvent('a');
      gtagEvent('a', { k: 'v' });
      gtagLogin('tok');
      gtagLogout();
    }).not.toThrow();
  });

  it('forwards arguments unchanged when gtag exists', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    gtagEvent('a', { k: 'v' });
    gtagLogout();
    expect(gtag).toHaveBeenNthCalledWith(1, 'event', 'a', { k: 'v' });
    expect(gtag).toHaveBeenNthCalledWith(2, 'config', 'G-Y4Y8KMLPQ7', { user_id: null });
  });
});
