'use strict';

const { detect } = require('detect-browser');

/**
 * A zimos.co visitor's device, for the console's Site visits
 * (SITE_VISITOR_DETAILS_ENABLED): the model, the operating system's version
 * and the browser's version, from the User-Agent plus User-Agent Client Hints
 * when the browser gives them (the request's Sec-CH-UA-* headers, or the
 * beacon's own copy of navigator.userAgentData). Anything not known is null:
 * nothing is guessed.
 *
 * What browsers hide, and so stays null:
 *  - Chrome on Android sends "Android 10; K" for every phone (a frozen value),
 *    so its model and version come only from Client Hints.
 *  - Every browser on a Mac says macOS 10.15.7, whatever the version.
 *  - Windows 10 and 11 both say "Windows NT 10.0"; only Client Hints tell them
 *    apart (platform version 13 or more is Windows 11).
 *  - Apple devices never say which model: an iPhone is "iPhone".
 */

const clip = (value, max) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

/** A structured-header string ("Pixel 7") without its quotes. */
function unquote(value) {
  if (value === null || value === undefined) return null;
  return clip(String(value).replace(/^"(.*)"$/, '$1'), 60);
}

/** "131.0.0" -> "131", "17.5.0" -> "17.5". */
function shortVersion(version) {
  const parts = String(version || '').split('.');
  if (!/^\d+$/.test(parts[0] || '')) return null;
  return parts[1] && /^\d+$/.test(parts[1]) && parts[1] !== '0' ? `${parts[0]}.${parts[1]}` : parts[0];
}

/** "14.0.0" -> "14"; "10.15.7" -> "10.15". */
const platformVersion = (value, keepMinor) => {
  const parts = String(value || '').split('.');
  if (!/^\d+$/.test(parts[0] || '')) return null;
  return keepMinor && parts[1] && parts[1] !== '0' ? `${parts[0]}.${parts[1]}` : parts[0];
};

const WINDOWS_NT = { '6.1': '7', '6.2': '8', '6.3': '8.1' };
const NOT_A_MODEL = /^(k|mobile|tablet|wv|linux|u)$/i;

function osVersionOf(ua, hintVersion) {
  const nt = /Windows NT (\d+\.\d+)/.exec(ua);
  if (nt) {
    if (nt[1] !== '10.0') return WINDOWS_NT[nt[1]] || null;
    const major = Number(platformVersion(hintVersion));
    if (!Number.isFinite(major) || major < 1) return null;
    return major >= 13 ? '11' : '10';
  }
  const ios = /(?:iPhone|iPad|iPod|CPU) OS (\d+)[_.](\d+)/.exec(ua);
  if (ios) return ios[2] === '0' ? ios[1] : `${ios[1]}.${ios[2]}`;
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) {
    if (hintVersion) return platformVersion(hintVersion);
    // Chrome's reduced User-Agent: "Android 10; K" says nothing true.
    return /Android 10; K[;)]/.test(ua) ? null : platformVersion(android[1]);
  }
  const mac = /Mac OS X (\d+)[_.](\d+)/.exec(ua);
  if (mac) {
    if (hintVersion) return platformVersion(hintVersion, true);
    // Every browser on a Mac today freezes it at 10.15.
    return mac[1] === '10' && Number(mac[2]) >= 15 ? null : `${mac[1]}.${mac[2]}`;
  }
  return null;
}

function modelOf(ua, hintModel) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPod/.test(ua)) return 'iPod';
  const hinted = unquote(hintModel);
  if (hinted) return clip(hinted, 40);
  const android = /Android [\d.]+;(?: [a-z]{2}[-_][A-Za-z]{2};)? ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua);
  if (!android) return null;
  const model = android[1].replace(/^SAMSUNG /i, '').trim();
  return model && !NOT_A_MODEL.test(model) ? clip(model, 40) : null;
}

/**
 * `userAgent` the request's; `hints` { model, platformVersion } from the
 * beacon's body, each falling back to the request's Sec-CH-UA-* header
 * through `getHeader`.
 */
function parseDevice({ userAgent, getHeader = () => undefined, hints = {} }) {
  const ua = String(userAgent || '');
  const model = hints.model || getHeader('sec-ch-ua-model');
  const version = hints.platformVersion || unquote(getHeader('sec-ch-ua-platform-version'));
  const browser = ua ? detect(ua) : null;
  return {
    model: ua ? modelOf(ua, model) : null,
    osVersion: ua ? clip(osVersionOf(ua, version), 20) : null,
    browserVersion: browser && browser.type === 'browser' ? clip(shortVersion(browser.version), 20) : null,
  };
}

/** "390x844", each side 1 to 5 digits; anything else is null. */
function screenOf(value) {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(String(value || ''));
  return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? `${Number(match[1])}x${Number(match[2])}` : null;
}

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/** The browser's language as the beacon sent it, else the first of Accept-Language. */
function languageOf(value, acceptLanguage) {
  const first = String(acceptLanguage || '').split(',')[0].split(';')[0].trim();
  const tag = value || first;
  return tag && LANGUAGE.test(tag) && tag.length <= 20 ? tag : null;
}

module.exports = { parseDevice, screenOf, languageOf, shortVersion };
