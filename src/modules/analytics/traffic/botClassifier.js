'use strict';

const { isbot } = require('isbot');

/**
 * Which kind of client a User-Agent names, for the events guard.
 *
 *   search   a search engine's crawler (Googlebot, Bingbot, …)        good
 *   preview  a link preview (WhatsApp, Facebook, Telegram, …)        good
 *   seo      an SEO or ads crawler (Ahrefs, Semrush, …)               not good
 *   tool     a script, an HTTP library or a headless browser          not good
 *   other    a bot isbot knows that none of the lists names           not good
 *
 * None of them is a shopper: every kind is kept out of the numbers. "Good"
 * only decides how the console shows it — a crawler a store wants visiting is
 * not an attack. An empty User-Agent is a tool: every browser sends one.
 *
 * The label is the family's short name (googlebot, curl, …), never the raw
 * header, so the daily counts have a bounded set of keys.
 */

const FAMILIES = [
  // search
  ['search', 'googlebot', /googlebot|google-inspectiontool|storebot-google|googleother/i],
  ['search', 'google-ads', /adsbot-google|mediapartners-google|google-adwords/i],
  ['search', 'bingbot', /bingbot|bingpreview|msnbot|adidxbot/i],
  ['search', 'yandex', /yandexbot|yandex\.com\/bots/i],
  ['search', 'baidu', /baiduspider/i],
  ['search', 'duckduckgo', /duckduckbot|duckassistbot/i],
  ['search', 'applebot', /applebot/i],
  ['search', 'yahoo', /slurp/i],
  ['search', 'petalbot', /petalbot/i],
  // link previews
  ['preview', 'facebook', /facebookexternalhit|facebookcatalog|meta-externalagent|facebot/i],
  ['preview', 'whatsapp', /whatsapp/i],
  ['preview', 'telegram', /telegrambot/i],
  ['preview', 'twitter', /twitterbot/i],
  ['preview', 'linkedin', /linkedinbot/i],
  ['preview', 'slack', /slackbot|slack-imgproxy/i],
  ['preview', 'discord', /discordbot/i],
  // Not /pinterest/, /snapchat/ or /tiktok/: their apps' own in-app browsers
  // carry those words, and the people in them are shoppers.
  ['preview', 'pinterest', /pinterestbot|pinterest\/0\./i],
  ['preview', 'snapchat', /snap url preview/i],
  // SEO / ads / data crawlers
  ['seo', 'ahrefs', /ahrefs/i],
  ['seo', 'semrush', /semrush/i],
  ['seo', 'mj12', /mj12bot/i],
  ['seo', 'dotbot', /dotbot/i],
  ['seo', 'dataforseo', /dataforseo/i],
  ['seo', 'ai-crawler', /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|amazonbot|diffbot|bytespider/i],
  // scripts and automation
  ['tool', 'headless', /headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed/i],
  ['tool', 'curl', /^curl\/|\bcurl\b/i],
  ['tool', 'wget', /wget/i],
  ['tool', 'python', /python|aiohttp|httpx|scrapy/i],
  ['tool', 'go', /go-http-client|\bgo\/\d/i],
  ['tool', 'java', /\bjava\/|okhttp|apache-httpclient/i],
  ['tool', 'node', /node-fetch|undici|axios|\bnode\.js|got \(/i],
  ['tool', 'php', /\bphp\/|guzzlehttp/i],
  ['tool', 'ruby', /\bruby\b|faraday/i],
  ['tool', 'perl', /libwww-perl|lwp::/i],
  ['tool', 'postman', /postmanruntime|insomnia|httpie/i],
];

const GOOD_KINDS = new Set(['search', 'preview']);

/**
 * `{ bot: false }` for a browser; else `{ bot: true, kind, label, good }`.
 */
function classify(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return { bot: true, kind: 'tool', label: 'empty', good: false };
  for (const [kind, label, pattern] of FAMILIES) {
    if (pattern.test(ua)) return { bot: true, kind, label, good: GOOD_KINDS.has(kind) };
  }
  if (isbot(ua)) return { bot: true, kind: 'other', label: 'other', good: false };
  return { bot: false };
}

module.exports = { classify, GOOD_KINDS };
