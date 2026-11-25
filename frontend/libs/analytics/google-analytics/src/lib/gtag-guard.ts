/**
 * Every gtag call goes through here. A no-op when gtag is absent (pod mode, blocked tag,
 * or not yet bootstrapped), instead of throwing a TypeError.
 */
export function callGtag(...args: unknown[]): void {
  if (typeof window === 'undefined') return;
  const gtag = (window as unknown as { gtag?: unknown }).gtag;
  if (typeof gtag !== 'function') return;
  gtag(...args);
}
