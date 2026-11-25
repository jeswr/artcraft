import { afterEach, describe, expect, it } from 'vitest';
import { applyPodModePolicy } from './apply-policy.js';
import { enterPodMode } from './pod-mode.js';
import { podPolicyApplied, POD_MODE_FLAG_KEY, POD_MODE_ORIGINS_KEY, resetPodWindowForTests } from './window-state.js';
import { memoryStorage } from './testing.js';

afterEach(() => resetPodWindowForTests());

const newDoc = () => document.implementation.createHTMLDocument('x');

describe('applyPodModePolicy', () => {
  it('inserts the meta as first child of head in a pod window, with hosted and pod origins', async () => {
    const storage = memoryStorage();
    await enterPodMode({ issuer: 'https://id.example' }, { storage, reload: () => {} });
    const doc = newDoc();
    doc.head.appendChild(doc.createElement('title'));
    expect(applyPodModePolicy(doc, { storage })).toBe(true);
    const first = doc.head.firstElementChild as HTMLMetaElement;
    expect(first.httpEquiv.toLowerCase()).toBe('content-security-policy');
    expect(first.content).toContain('https://id.example');
    const connect = first.content.split('; ').find((d) => d.startsWith('connect-src '));
    expect(connect).toContain('http://ipc.localhost'); // hosted connect sources are passed through
    expect(connect).toContain('https://id.example');
  });

  it('still inserts a policy when remembered origins are corrupt (fail closed)', () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    storage.setItem(POD_MODE_ORIGINS_KEY, '{');
    const doc = newDoc();
    expect(applyPodModePolicy(doc, { storage })).toBe(true);
    expect(doc.head.querySelector('meta')?.content).toContain("script-src 'self'");
  });

  it('does nothing outside pod mode', () => {
    const doc = newDoc();
    expect(applyPodModePolicy(doc, { storage: memoryStorage() })).toBe(false);
    expect(doc.head.querySelector('meta[http-equiv]')).toBeNull();
  });

  it('throws instead of inserting outside <head> when there is none', () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    const doc = newDoc();
    doc.head.remove();
    expect(() => applyPodModePolicy(doc, { storage })).toThrow();
    expect(doc.documentElement.querySelector('meta')).toBeNull();
  });

  it('builds the policy from the shell\'s origins and records that a policy is in force', () => {
    const readHost = () => ({ enabled: true, issuer: 'https://id.example', storageOrigins: ['https://pod.example', 'https://pod2.example'], headerPolicy: false, credentialsMayExist: true });
    const doc = newDoc();
    expect(podPolicyApplied({ readHost })).toBe(false);
    expect(applyPodModePolicy(doc, { readHost })).toBe(true);
    const connect = doc.head.querySelector('meta')?.content.split('; ').find((d) => d.startsWith('connect-src '));
    expect(connect).toContain('https://pod.example');
    expect(connect).toContain('https://pod2.example');
    expect(podPolicyApplied({ readHost })).toBe(true);
  });

  it('records no policy when the insertion throws', () => {
    const readHost = () => ({ enabled: true, storageOrigins: [], headerPolicy: false, credentialsMayExist: true });
    const doc = newDoc();
    doc.head.remove();
    expect(() => applyPodModePolicy(doc, { readHost })).toThrow();
    expect(podPolicyApplied({ readHost })).toBe(false);
  });
});
