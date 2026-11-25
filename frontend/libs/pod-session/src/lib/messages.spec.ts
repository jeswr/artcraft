import { describe, expect, it } from 'vitest';
import { ERROR_TEXT, noticeFor, UNSUPPORTED_TEXT } from './messages.js';
import type { PodSessionState } from './state.js';

describe('noticeFor', () => {
  const connected: PodSessionState = { kind: 'connected', webId: 'https://pod.example/me#i' };

  it('announces a connection once', () => {
    expect(noticeFor({ kind: 'signing-in', issuer: 'https://login.example' }, connected)).toMatchObject({ level: 'success' });
    expect(noticeFor(null, connected)).toMatchObject({ level: 'success' });
    expect(noticeFor(connected, { ...connected })).toBeNull();
  });

  it('announces a finished disconnect', () => {
    const notice = noticeFor({ kind: 'leaving', step: 'clearing' }, { kind: 'disconnected', outcome: 'disconnected' });
    expect(notice?.level).toBe('success');
    expect(notice?.message).toMatch(/removed from this computer/);
  });

  it('says plainly when the provider could not be told', () => {
    const notice = noticeFor(null, { kind: 'signed-out-locally' });
    expect(notice?.level).toBe('error');
    expect(notice?.message).toMatch(/could not be told/);
  });

  it('gives every error kind its own sentence', () => {
    for (const [error, text] of Object.entries(ERROR_TEXT)) {
      expect(noticeFor(null, { kind: 'error', error: error as keyof typeof ERROR_TEXT })).toEqual({ level: 'error', message: text });
    }
  });

  it('stays quiet for steps the person is already looking at', () => {
    expect(noticeFor(null, { kind: 'disconnected' })).toBeNull();
    expect(noticeFor(null, { kind: 'disconnected', outcome: 'declined' })).toBeNull();
    expect(noticeFor(null, { kind: 'connecting', issuer: 'https://login.example' })).toBeNull();
    expect(noticeFor(null, { kind: 'leaving', step: 'revoking' })).toBeNull();
    expect(noticeFor(null, { kind: 'unsupported', reason: 'web-locks-missing' })).toBeNull();
    expect(Object.keys(UNSUPPORTED_TEXT)).toHaveLength(6);
  });
});
