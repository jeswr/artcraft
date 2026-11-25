import { callGtag } from './gtag-guard.js';
import { TAG_ID } from './tag-id.js';

export const gtagLogin = function(userToken: string) {
  console.debug("gtagLogin", TAG_ID, userToken);

  callGtag(
    'config', TAG_ID, {
    'user_id': userToken
  });
}
