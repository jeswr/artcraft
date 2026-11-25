import { buildPodModeCsp, HOSTED_CONNECT_SOURCES } from './csp.js';
import { readPodModeOrigins } from './pod-mode.js';
import { isPodMode, markMetaPolicyApplied, type PodModeDeps } from './window-state.js';

/**
 * In a pod window, insert the narrowing CSP as the very first child of <head> and return true.
 * Otherwise do nothing and return false. If the origins are missing or corrupt the policy is
 * still inserted, with no pod origins (fail closed). Throws when there is no <head>, because a
 * meta policy outside <head> is ignored. A meta policy is defence in depth next to the shell's
 * response header, and the only policy in a dev server; `podPolicyApplied()` reports whether
 * either is in force, and sign-in refuses without it. That the browser enforces a
 * script-inserted meta policy has to be confirmed per webview.
 */
export function applyPodModePolicy(doc: Document = document, deps: PodModeDeps = {}): boolean {
  if (!isPodMode(deps)) return false;
  const head = doc.head;
  if (!head) throw new Error('applyPodModePolicy: document has no <head>');
  const origins = readPodModeOrigins(deps);
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = buildPodModeCsp(
    { ...(origins?.issuer === undefined ? {} : { issuer: origins.issuer }), storage: origins?.storageOrigins ?? [] },
    HOSTED_CONNECT_SOURCES,
  );
  head.insertBefore(meta, head.firstChild);
  markMetaPolicyApplied();
  return true;
}
