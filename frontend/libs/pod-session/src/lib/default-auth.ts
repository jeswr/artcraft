import { createDesktopCodeDriver, type DesktopHost } from '@jeswr/desktop-auth';
import { createPodAuth } from '@jeswr/pod-auth';
import type { PodSessionConfig } from './config.js';
import { refuseSignIn } from './sign-in-gate.js';
import type { AuthOptions, PodAuthPort } from './pod-session.js';

/**
 * pod-auth for a desktop shell: the system browser opens the provider's page and the callback
 * returns through the host's deep-link listener, which `@jeswr/desktop-auth` consumes directly.
 * Nothing here reads, stores or logs the callback URL. The login hint (a WebID or an issuer) is
 * supplied by the caller, so the WebID prompt is refused. `options.fetch` is pod-auth's own
 * transport for its unauthenticated reads (discovery, the client document, the profile): the
 * session passes the origin gate there, so the window's policy and the app's dialog decide
 * which origins those reads may reach. `options.authorizeSignIn` is asked before the code driver
 * does anything: it throws unless the person's own sign-in is in progress, so a background read
 * whose token refresh failed can never open the browser. Without it nothing authorises the browser.
 */
export function createDefaultAuth(
  config: PodSessionConfig,
  host: DesktopHost,
  options: AuthOptions = {},
): PodAuthPort {
  // The system browser opens only after the session has shown the person where it is going and
  // they have clicked: the provider is whatever the profile names, so nothing earlier knows it.
  const confirmed: DesktopHost = options.confirmOpen
    ? {
        ...host,
        openUrl: async (url: string) => {
          await options.confirmOpen?.(url);
          return host.openUrl(url);
        },
      }
    : host;
  const driver = createDesktopCodeDriver({ host: confirmed, redirectUri: config.redirectUri });
  const authorize = options.authorizeSignIn ?? refuseSignIn;
  const getCode: typeof driver = async (...args) => {
    authorize();
    return driver(...args);
  };
  return createPodAuth({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    nativeRedirect: true,
    ui: {
      getWebId: () => Promise.reject(new Error('Signing in with a WebID is not offered')),
      getCode,
    },
  });
}
