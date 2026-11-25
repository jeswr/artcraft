/**
 * Why the system browser did not open: nobody asked for a sign-in. pod-auth asks for the
 * browser whenever it needs a new authorization, and that includes a background read whose
 * token refresh failed. The browser may open only for a sign-in the person started and is
 * still waiting for, so every other request is refused with this error.
 *
 * The message is fixed text. It never carries a URL, an issuer or anything pod-auth said.
 */
export class SignInNotInProgressError extends Error {
  readonly code = 'sign-in-not-in-progress';
  constructor() {
    super('The system browser opens only for a sign-in you started');
    this.name = 'SignInNotInProgressError';
  }
}

/** Throws unless the browser may open now. */
export type SignInGate = () => void;

/** The default: nothing authorises the browser. */
export const refuseSignIn: SignInGate = () => {
  throw new SignInNotInProgressError();
};
