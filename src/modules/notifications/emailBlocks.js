'use strict';

const Joi = require('joi');

/*
 * The block email designer: an order email or the cart-recovery email built
 * from blocks instead of one text body (STORE_FEATURES email_blocks).
 *
 *   heading     { text, align?, size?: 'lg' | 'md' }
 *   text        { text, align? }                 blank lines are paragraphs
 *   button      { label, url, align?, color? }   url: http(s) or a {{link}} variable
 *   image       { url, alt?, link?, width? }     https image, optional link
 *   order_table {}                               the order's (or cart's) lines and totals
 *   divider     {}
 *
 * Text fields take the same {{variables}} as the plain body. Everything is
 * rendered on the server from this JSON — escaped, with only http(s) links —
 * so the merchant never sends raw HTML to a customer.
 */

const MAX_BLOCKS = 40;
const ALIGN = ['start', 'center', 'end'];
const varOrUrl = Joi.string()
  .trim()
  .max(1000)
  .pattern(/^(https?:\/\/\S+|\{\{\s*[a-z_]+\s*\}\})$/)
  .messages({ 'string.pattern.base': 'Use a link starting with https:// or a link variable such as order_link' });

const blockSchema = Joi.object({
  type: Joi.string().valid('heading', 'text', 'button', 'image', 'order_table', 'divider').required(),
  text: Joi.when('type', { is: Joi.valid('heading', 'text'), then: Joi.string().max(5000).required(), otherwise: Joi.forbidden() }),
  label: Joi.when('type', { is: 'button', then: Joi.string().trim().min(1).max(80).required(), otherwise: Joi.forbidden() }),
  url: Joi.when('type', { is: Joi.valid('button', 'image'), then: varOrUrl.required(), otherwise: Joi.forbidden() }),
  link: Joi.when('type', { is: 'image', then: varOrUrl.allow(null, ''), otherwise: Joi.forbidden() }),
  alt: Joi.when('type', { is: 'image', then: Joi.string().max(200).allow(''), otherwise: Joi.forbidden() }),
  width: Joi.when('type', { is: 'image', then: Joi.number().integer().min(40).max(600), otherwise: Joi.forbidden() }),
  size: Joi.when('type', { is: 'heading', then: Joi.string().valid('lg', 'md'), otherwise: Joi.forbidden() }),
  color: Joi.when('type', { is: 'button', then: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/), otherwise: Joi.forbidden() }),
  align: Joi.string().valid(...ALIGN),
});
const blocksSchema = Joi.array().items(blockSchema).min(1).max(MAX_BLOCKS);

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);
const textAlign = (a) => (a === 'center' ? 'center' : a === 'end' ? 'left' : 'right'); // the email is RTL

/**
 * blocks + values → { html, text }. `fill(template)` replaces {{variables}};
 * `lines` is [{ name, quantity, total }] with `totals` { shipping?, total } as
 * formatted strings, for the order table.
 */
function renderBlocks(blocks, { fill, color = '#2563EB', lines = [], totals = {} }) {
  const html = [];
  const text = [];
  for (const b of blocks || []) {
    const align = `text-align:${textAlign(b.align)}`;
    if (b.type === 'heading') {
      const t = fill(b.text);
      html.push(`<h2 style="margin:0 0 12px;font-size:${b.size === 'md' ? 18 : 22}px;${align}">${escapeHtml(t)}</h2>`);
      text.push(t);
    } else if (b.type === 'text') {
      const t = fill(b.text);
      for (const p of t.split(/\n{2,}/)) html.push(`<p style="margin:0 0 14px;${align}">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`);
      text.push(t);
    } else if (b.type === 'button') {
      const url = safeUrl(fill(b.url));
      const label = fill(b.label);
      const bg = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : color;
      if (url) {
        html.push(`<p style="margin:18px 0;${align}"><a href="${escapeHtml(url)}" style="display:inline-block;background:${bg};color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`);
        text.push(`${label}: ${url}`);
      }
    } else if (b.type === 'image') {
      const src = safeUrl(fill(b.url));
      if (!src) continue;
      const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(fill(b.alt || ''))}" style="max-width:100%;width:${b.width || 600}px;height:auto;border:0" />`;
      const link = safeUrl(fill(b.link || ''));
      html.push(`<p style="margin:0 0 14px;${align}">${link ? `<a href="${escapeHtml(link)}">${img}</a>` : img}</p>`);
    } else if (b.type === 'order_table') {
      if (!lines.length) continue;
      const rows = lines
        .map((l) => `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">${escapeHtml(l.name)}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">${escapeHtml(l.quantity)}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:left">${escapeHtml(l.total)}</td></tr>`)
        .join('');
      const foot = [
        totals.shipping ? `<tr><td colspan="2" style="padding:8px">الشحن</td><td style="padding:8px;text-align:left">${escapeHtml(totals.shipping)}</td></tr>` : '',
        totals.total ? `<tr><td colspan="2" style="padding:8px;font-weight:bold">الإجمالي</td><td style="padding:8px;text-align:left;font-weight:bold">${escapeHtml(totals.total)}</td></tr>` : '',
      ].join('');
      html.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 16px;font-size:14px">${rows}${foot}</table>`);
      text.push([...lines.map((l) => `${l.name} × ${l.quantity}: ${l.total}`), totals.shipping && `الشحن: ${totals.shipping}`, totals.total && `الإجمالي: ${totals.total}`].filter(Boolean).join('\n'));
    } else if (b.type === 'divider') {
      html.push('<hr style="border:0;border-top:1px solid #e5e7eb;margin:18px 0" />');
      text.push('—');
    }
  }
  return { html: html.join('\n'), text: text.join('\n\n') };
}

module.exports = { blocksSchema, renderBlocks, MAX_BLOCKS, escapeHtml, safeUrl };
