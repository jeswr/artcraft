import { callGtag } from './gtag-guard.js';
import { TAG_ID } from './tag-id.js';

export const gtagLogout = function() {
  console.debug("gtagLogout", TAG_ID);

  callGtag(
    'config', TAG_ID, {
    'user_id': null
  });
}
