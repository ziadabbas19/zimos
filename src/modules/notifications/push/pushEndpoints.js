'use strict';

/**
 * Where a subscription's endpoint may point. The endpoint comes from the
 * browser and this server then POSTs to it, so only the browsers' own push
 * services are accepted: HTTPS, on the default port, with no user or password
 * in it, at one of the hosts below. Anything else is refused when the browser
 * subscribes (422) and again before every send, so a row written some other
 * way is never sent to.
 *
 *   fcm        fcm.googleapis.com (Chrome, Edge on Android, Samsung Internet, Opera, Brave)
 *   mozilla    updates.push.services.mozilla.com (Firefox)
 *   apple      *.push.apple.com (Safari on macOS, iPhone and iPad)
 *   windows    *.notify.windows.com (Edge on Windows)
 */

const SERVICES = [
  { service: 'fcm', matches: (host) => host === 'fcm.googleapis.com' },
  { service: 'mozilla', matches: (host) => host === 'updates.push.services.mozilla.com' },
  { service: 'apple', matches: (host) => host.endsWith('.push.apple.com') },
  { service: 'windows', matches: (host) => host.endsWith('.notify.windows.com') },
];

const SERVICE_NAMES = SERVICES.map((s) => s.service);

const MAX_ENDPOINT_LENGTH = 2048;

// One DNS label per part: letters, digits and inner hyphens.
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** The push service an endpoint belongs to, or null when it may not be sent to. */
function serviceOf(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!HOST_PATTERN.test(host)) return null;
  const found = SERVICES.find((s) => s.matches(host));
  return found ? found.service : null;
}

module.exports = { serviceOf, SERVICE_NAMES, MAX_ENDPOINT_LENGTH };
