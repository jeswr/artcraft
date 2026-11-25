import { buildPodModeCsp, HOSTED_CONNECT_SOURCES } from './csp.js';
import { readPodOrigins } from './pod-mode.js';
import { isPodMode, type PodModeDeps } from './window-state.js';

/**
 * In a pod window, insert the narrowing CSP as the very first child of <head> and return true.
 * Otherwise do nothing and return false. If the remembered origins are missing or corrupt the
 * policy is still inserted, with no pod origins (fail closed). Throws when there is no <head>,
 * because a meta policy outside <head> is ignored. That the browser enforces a script-inserted
 * meta policy has to be confirmed per webview.
 */
export function applyPodModePolicy(doc: Document = document, deps: PodModeDeps = {}): boolean {
  if (!isPodMode(deps)) return false;
  const head = doc.head;
  if (!head) throw new Error('applyPodModePolicy: document has no <head>');
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = buildPodModeCsp(readPodOrigins(deps) ?? {}, HOSTED_CONNECT_SOURCES);
  head.insertBefore(meta, head.firstChild);
  return true;
}
