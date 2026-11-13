'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { escapeHtml, safeUrl } = require('../notifications/emailBlocks');
const { formatAmount } = require('../cartRewards/cartRewardRules');

/**
 * A campaign's blocks → { subject, html, text }: the email-safe HTML (nested
 * tables, inline styles, a 600px column that narrows on a phone) and its
 * plain-text twin, under the store's logo and colour, right-to-left for an
 * Arabic campaign.
 *
 * Everything the merchant typed is escaped here and only http(s) links get
 * through (emailBlocks.safeUrl); colours are #rrggbb or the store's. Product
 * blocks are read from the store's own active products at render time, so a
 * price or picture is the current one and another store's product never shows.
 *
 * The unsubscribe link differs per recipient: a campaign is rendered once with
 * a random placeholder (`render(...).withLink(url)` fills it), never something
 * the merchant could type into their text.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Tahoma,Arial,sans-serif";
const INK = '#18181b';
const SOFT = '#52525b';
const LINE = '#e4e4e7';
const DEFAULT_COLOR = '#2563eb';

const COPY = {
  ar: {
    why: (store) => `وصلتك هذه الرسالة لأنك وافقت على تلقي العروض من ${store}.`,
    unsubscribe: 'إلغاء الاشتراك',
    unsubscribeText: 'لإلغاء الاشتراك من هذه الرسائل',
    shop: 'تسوّق الآن',
    view: 'عرض',
  },
  en: {
    why: (store) => `You're getting this email because you agreed to hear from ${store}.`,
    unsubscribe: 'Unsubscribe',
    unsubscribeText: 'To stop these emails',
    shop: 'Shop now',
    view: 'View',
  },
};

const hexColor = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback);

/** White or near-black, whichever reads on `hex` (WCAG relative luminance). */
function inkOn(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contrast with white (1.05 / (L + 0.05)) against contrast with #18181b (≈ (L + 0.05) / 0.0587).
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.0587 ? '#ffffff' : INK;
}

function alignOf(align, dir) {
  if (align === 'center') return 'center';
  const start = dir === 'rtl' ? 'right' : 'left';
  const end = dir === 'rtl' ? 'left' : 'right';
  return align === 'end' ? end : start;
}

/** Escaped text with blank lines as paragraphs and http(s) addresses as links. */
function paragraphs(text, { align, color }) {
  const linkify = (escaped) => escaped.replace(/(https?:\/\/[^\s<&]+)/g, (url) => `<a href="${url}" style="color:${color};text-decoration:underline">${url}</a>`);
  return String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${INK};text-align:${align}">${linkify(escapeHtml(p)).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

function buttonHtml({ label, url, color, align }) {
  const ink = inkOn(color);
  // The outer cell places the button (td align moves a nested table in every client; a margin on it wouldn't).
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px">
<tr><td align="${align}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td bgcolor="${color}" style="background:${color};border-radius:8px;mso-padding-alt:14px 28px">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:bold;line-height:1.2;color:${ink};text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>
</td></tr></table>
</td></tr></table>`;
}

/** The store's active products, in the order the block names them; unknown or other stores' ids are dropped. */
async function loadProducts(workspaceId, ids) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT p.id, p.name, p.slug, p.media,
            (SELECT min(v.price_amount) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') AS price,
            (SELECT v.currency FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active' ORDER BY v.price_amount, v.id LIMIT 1) AS currency,
            (SELECT v.image_url FROM product_variants v WHERE v.product_id = p.id AND v.image_url IS NOT NULL ORDER BY v.created_at, v.id LIMIT 1) AS variant_image
       FROM products p
      WHERE p.workspace_id = :workspaceId AND p.id IN (:ids) AND p.status = 'active'`,
    { replacements: { workspaceId, ids: wanted }, type: db.Sequelize.QueryTypes.SELECT }
  );
  const map = new Map();
  for (const r of rows) {
    const media = Array.isArray(r.media) ? r.media : [];
    const first = media.find((m) => m && typeof m.url === 'string' && m.url);
    map.set(r.id, {
      id: r.id,
      name: r.name,
      slug: r.slug,
      price: r.price === null || r.price === undefined ? null : Number(r.price),
      currency: r.currency,
      imageUrl: safeUrl(first ? first.url : r.variant_image),
    });
  }
  return map;
}

function productsHtml(block, { products, origin, dir, locale, color, copy }) {
  const items = block.productIds.map((id) => products.get(id)).filter(Boolean);
  if (items.length === 0) return { html: '', text: '' };
  const showPrice = block.showPrice !== false;
  const cell = (p) => {
    const href = origin ? `${origin}/products/${encodeURIComponent(p.slug || p.id)}` : null;
    const price = showPrice && p.price !== null ? formatAmount(p.price, p.currency || 'EGP', locale) : null;
    const picture = p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" width="252" style="display:block;width:100%;max-width:252px;height:auto;border:0;border-radius:8px;margin:0 auto 10px" />`
      : '';
    const wrapped = href && picture ? `<a href="${escapeHtml(href)}">${picture}</a>` : picture;
    return `<td valign="top" width="50%" style="padding:8px;text-align:center;font-family:${FONT}">
${wrapped}<p style="margin:0 0 4px;font-size:15px;line-height:1.4;font-weight:bold;color:${INK}">${escapeHtml(p.name)}</p>
${price ? `<p style="margin:0 0 10px;font-size:15px;color:${SOFT}"><bdi>${escapeHtml(price)}</bdi></p>` : ''}
${href ? `<a href="${escapeHtml(href)}" style="font-size:14px;font-weight:bold;color:${color};text-decoration:underline">${escapeHtml(copy.view)}</a>` : ''}
</td>`;
  };
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2);
    rows.push(`<tr>${pair.map(cell).join('')}${pair.length === 1 ? '<td width="50%" style="padding:8px"></td>' : ''}</tr>`);
  }
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="margin:0 0 16px">${rows.join('')}</table>`;
  const text = items
    .map((p) => {
      const price = showPrice && p.price !== null ? ` — ${formatAmount(p.price, p.currency || 'EGP', locale)}` : '';
      const href = origin ? `: ${origin}/products/${encodeURIComponent(p.slug || p.id)}` : '';
      return `• ${p.name}${price}${href}`;
    })
    .join('\n');
  return { html, text };
}

function blockHtml(block, ctx) {
  const { dir, color } = ctx;
  const align = alignOf(block.align, dir);
  switch (block.type) {
    case 'heading': {
      const size = block.size === 'md' ? 20 : 26;
      return {
        html: `<h${block.size === 'md' ? 2 : 1} style="margin:0 0 14px;font-family:${FONT};font-size:${size}px;line-height:1.3;font-weight:bold;color:${INK};text-align:${align}">${escapeHtml(block.text)}</h${block.size === 'md' ? 2 : 1}>`,
        text: block.text,
      };
    }
    case 'text':
      return { html: paragraphs(block.text, { align, color }), text: block.text };
    case 'image': {
      const src = safeUrl(block.url);
      if (!src) return { html: '', text: '' };
      const width = block.width || 552;
      const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt || '')}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;${align === 'center' ? 'margin:0 auto' : align === 'left' ? 'margin:0 auto 0 0' : 'margin:0 0 0 auto'}" />`;
      const link = safeUrl(block.link);
      return {
        html: `<div style="margin:0 0 16px">${link ? `<a href="${escapeHtml(link)}">${img}</a>` : img}</div>`,
        text: [block.alt, link].filter(Boolean).join(': '),
      };
    }
    case 'button': {
      const url = safeUrl(block.url);
      if (!url) return { html: '', text: '' };
      return { html: buttonHtml({ label: block.label, url, color: hexColor(block.color, color), align }), text: `${block.label}: ${url}` };
    }
    case 'products':
      return productsHtml(block, ctx);
    case 'divider':
      return { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td style="border-top:1px solid ${LINE};font-size:0;line-height:0">&nbsp;</td></tr></table>`, text: '———' };
    default:
      return { html: '', text: '' };
  }
}

/** What a store's emails look like: its name, logo, colour, address and currency. */
async function storeBrand(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'logoUrl', 'themeSettings', 'defaultCurrency'] });
  if (!workspace) return null;
  const origin = await require('../domains/primaryHost').storeOriginOf(workspace);
  return {
    name: workspace.name || '',
    logoUrl: safeUrl(workspace.logoUrl),
    color: hexColor(workspace.themeSettings && workspace.themeSettings.primaryColor, DEFAULT_COLOR),
    origin: origin || '',
    currency: workspace.defaultCurrency || 'EGP',
  };
}

/** A header-safe line: no line breaks, no control characters. */
const headerLine = (value, max) => String(value || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, max);

/**
 * { subject, preheader, blocks, locale } of one campaign → the email, once.
 * `brand` is storeBrand(workspaceId) (read here when not given).
 * Returns { subject, html, text, withLink(url) → { html, text } }.
 */
async function render(workspaceId, campaign, { brand: given } = {}) {
  const brand = given || (await storeBrand(workspaceId)) || { name: '', logoUrl: null, color: DEFAULT_COLOR, origin: '', currency: 'EGP' };
  const locale = campaign.locale === 'en' ? 'en' : 'ar';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const copy = COPY[locale];
  const blocks = Array.isArray(campaign.blocks) ? campaign.blocks : [];
  const productIds = blocks.filter((b) => b && b.type === 'products').flatMap((b) => b.productIds || []);
  const products = await loadProducts(workspaceId, productIds);
  const ctx = { dir, locale, color: brand.color, origin: brand.origin, products, copy };

  const parts = blocks.map((b) => blockHtml(b, ctx));
  const bodyHtml = parts.map((p) => p.html).filter(Boolean).join('\n');
  const bodyText = parts.map((p) => p.text).filter(Boolean).join('\n\n');
  const subject = headerLine(campaign.subject, 200);
  const preheader = headerLine(campaign.preheader, 200);
  const store = escapeHtml(brand.name);
  const start = dir === 'rtl' ? 'right' : 'left';

  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${store}" height="48" style="display:block;height:48px;width:auto;max-width:200px;border:0;margin:0 auto" />`
    : `<span style="font-family:${FONT};font-size:20px;font-weight:bold;color:${INK}">${store}</span>`;
  const header = brand.origin ? `<a href="${escapeHtml(brand.origin)}" style="text-decoration:none">${logo}</a>` : logo;

  // A random placeholder per render: nothing a merchant types can be swapped for the link.
  const slot = `__unsub_${crypto.randomBytes(9).toString('hex')}__`;
  const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light only" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;-webkit-text-size-adjust:100%">
${preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preheader)}${'&#8204;&nbsp;'.repeat(40)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="height:4px;background:${brand.color};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td align="center" style="padding:28px 24px 12px">${header}</td></tr>
<tr><td dir="${dir}" style="padding:12px 24px 20px;font-family:${FONT};font-size:16px;line-height:1.65;color:${INK};text-align:${start}">
${bodyHtml}
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:600px">
<tr><td style="padding:18px 24px;font-family:${FONT};font-size:13px;line-height:1.6;color:${SOFT};text-align:center">
<p style="margin:0 0 6px">${escapeHtml(copy.why(brand.name))}</p>
<p style="margin:0"><a href="${slot}" style="color:${SOFT};text-decoration:underline">${escapeHtml(copy.unsubscribe)}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [bodyText, '—', brand.name, brand.origin, `${copy.why(brand.name)}\n${copy.unsubscribeText}: ${slot}`].filter(Boolean).join('\n\n');

  return {
    subject,
    html,
    text,
    withLink(url) {
      const safe = safeUrl(url) || '#';
      return { html: html.split(slot).join(escapeHtml(safe)), text: text.split(slot).join(safe) };
    },
  };
}

module.exports = { render, storeBrand, loadProducts, inkOn, alignOf, headerLine };
