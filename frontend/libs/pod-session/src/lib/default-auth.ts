import { createDesktopCodeDriver, type DesktopHost } from '@jeswr/desktop-auth';
import { createPodAuth } from '@jeswr/pod-auth';
import type { PodSessionConfig } from './config.js';
import type { PodAuthPort } from './pod-session.js';

/**
 * pod-auth for a desktop shell: the system browser opens the provider's page and the callback
 * returns through the host's deep-link listener, which `@jeswr/desktop-auth` consumes directly.
 * Nothing here reads, stores or logs the callback URL. The login hint (a WebID or an issuer) is
 * supplied by the caller, so the WebID prompt is refused. `options.fetch` is pod-auth's own
 * transport for its unauthenticated reads (discovery, the client document, the profile): the
 * session passes the origin gate there, so the window's policy and the app's dialog decide
 * which origins those reads may reach.
 */
export function createDefaultAuth(
  config: PodSessionConfig,
  host: DesktopHost,
  options: { fetch?: typeof fetch } = {},
): PodAuthPort {
  return createPodAuth({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    nativeRedirect: true,
    ui: {
      getWebId: () => Promise.reject(new Error('Signing in with a WebID is not offered')),
      getCode: createDesktopCodeDriver({ host, redirectUri: config.redirectUri }),
    },
  });
}
