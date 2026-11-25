import { callGtag } from './gtag-guard.js';

// Send an event with name and "args". Args is a string-to-string map.
export const gtagEvent = function(eventName: string, args?: { [key: string]: string }) {
  console.debug("gtagEvent", eventName, args);
  if (!args) {
    callGtag('event', eventName);
  } else {
    callGtag('event', eventName, args);
  }
}
