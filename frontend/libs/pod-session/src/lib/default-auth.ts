import { createDesktopCodeDriver, type DesktopHost } from '@jeswr/desktop-auth';
import { createPodAuth } from '@jeswr/pod-auth';
import type { PodSessionConfig } from './config.js';
import type { PodAuthPort } from './pod-session.js';

/**
 * pod-auth for a desktop shell: the system browser opens the provider's page and the callback
 * returns through the host's deep-link listener, which `@jeswr/desktop-auth` consumes directly.
 * Nothing here reads, stores or logs the callback URL. Only issuer sign-in is offered, so the
 * WebID prompt is refused.
 */
export function createDefaultAuth(config: PodSessionConfig, host: DesktopHost): PodAuthPort {
  return createPodAuth({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    nativeRedirect: true,
    ui: {
      getWebId: () => Promise.reject(new Error('Signing in with a WebID is not offered')),
      getCode: createDesktopCodeDriver({ host, redirectUri: config.redirectUri }),
    },
  });
}
