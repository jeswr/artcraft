/**
 * Build-time identity of this build as a Solid-OIDC client.
 *
 * The client identifier is a placeholder until the owner decides where the Client Identifier
 * Document is hosted; `.invalid` never resolves, so no sign-in starts against it and Connect
 * stays disabled. A real build sets `VITE_SOLID_CLIENT_ID` (an https URL of a document with
 * `application_type: native` listing exactly the redirect below).
 *
 * The redirect is a private-use scheme (RFC 8252 section 7.1): the app identifier in reverse
 * domain form, then `:/oauth/callback`. The shell registers that scheme from its identifier,
 * so the app derives the redirect from `getIdentifier()` (release `ai.artcraft.app`, dev
 * overlays `ai.artcraft.app.dev`) and a dev build never receives a release callback.
 */
export type PodSessionConfig = {
  clientId: string;
  redirectUri: string;
  /** Dev builds only: lets an issuer on http://localhost or http://127.0.0.1 through. */
  allowLoopbackHttp: boolean;
};

export const PLACEHOLDER_CLIENT_ID = 'https://client-id.placeholder.invalid/artcraft/solid-client-id.jsonld';
export const CALLBACK_PATH = ':/oauth/callback';

export type ConfigEnv = Record<string, unknown>;

export function redirectUriFor(identifier: string): string {
  return `${identifier}${CALLBACK_PATH}`;
}

export function readConfig(identifier: string, env: ConfigEnv = import.meta.env ?? {}): PodSessionConfig {
  const clientId = env['VITE_SOLID_CLIENT_ID'];
  return {
    clientId: typeof clientId === 'string' && clientId.length > 0 ? clientId : PLACEHOLDER_CLIENT_ID,
    redirectUri: redirectUriFor(identifier),
    allowLoopbackHttp: env['VITE_SOLID_ALLOW_LOOPBACK'] === 'true' && env['DEV'] === true,
  };
}

/** True while the client identifier is still the placeholder, so sign-in cannot work yet. */
export function isPlaceholderClient(config: PodSessionConfig): boolean {
  return config.clientId === PLACEHOLDER_CLIENT_ID;
}

export type ConfigCheck = 'ok' | 'not-configured' | 'invalid';

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+$/;

/**
 * Checks the config before anything is built from it: an https client identifier URL (a
 * loopback http one only when `allowLoopbackHttp`), and a private-use redirect scheme in
 * reverse-domain form with the fixed callback path. A placeholder is reported as
 * `not-configured`, not as invalid.
 */
export function checkConfig(config: PodSessionConfig): ConfigCheck {
  if (isPlaceholderClient(config)) return 'not-configured';
  let client: URL;
  try {
    client = new URL(config.clientId);
  } catch {
    return 'invalid';
  }
  const loopbackHost = client.hostname === 'localhost' || client.hostname === '127.0.0.1';
  const schemeOk = client.protocol === 'https:' || (config.allowLoopbackHttp && client.protocol === 'http:' && loopbackHost);
  if (!schemeOk || client.username !== '' || client.password !== '' || client.hash !== '') return 'invalid';
  if (!config.redirectUri.endsWith(CALLBACK_PATH)) return 'invalid';
  const scheme = config.redirectUri.slice(0, -CALLBACK_PATH.length);
  return SCHEME_PATTERN.test(scheme) ? 'ok' : 'invalid';
}
