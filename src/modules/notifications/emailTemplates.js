'use strict';

const env = require('../../config/env');

// Renders transactional emails to { subject, html, text }. Every template
// goes through `wrap`, which appends the shared spam-folder footer.

const SPAM_FOOTER =
  "Didn't get this email? Check your spam/junk folder and mark it as 'not spam' so future emails land in your inbox.";

function wrap(bodyHtml, bodyText) {
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px" />
<p style="font-size:13px;color:#6b7280;margin:0">${SPAM_FOOTER}</p>
</div>`;
  const text = `${bodyText}\n\n---\n${SPAM_FOOTER}`;
  return { html, text };
}

const link = (path, token) =>
  `${env.frontendUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

const templates = {
  email_verification(data = {}) {
    const url = link('/verify-email', data.token || '');
    const name = data.fullName ? `Hi ${data.fullName},` : 'Hi,';
    return {
      subject: 'Confirm your email address',
      ...wrap(
        `<p>${name}</p>
<p>Confirm your email address to finish setting up your account:</p>
<p><a href="${url}">Confirm my email</a></p>
<p>If the link doesn't work, paste this into your browser:<br /><span style="color:#6b7280">${url}</span></p>`,
        `${name}\n\nConfirm your email address to finish setting up your account:\n${url}`
      ),
    };
  },

  password_reset(data = {}) {
    const url = link('/reset-password', data.token || '');
    const name = data.fullName ? `Hi ${data.fullName},` : 'Hi,';
    return {
      subject: 'Reset your password',
      ...wrap(
        `<p>${name}</p>
<p>We got a request to reset your password. This link is valid for one hour:</p>
<p><a href="${url}">Reset my password</a></p>
<p>If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
        `${name}\n\nWe got a request to reset your password. This link is valid for one hour:\n${url}\n\nIf you didn't ask for this, you can ignore this email.`
      ),
    };
  },

  workspace_invite(data = {}) {
    const store = data.workspaceName || 'a store';
    const role = data.roleName ? ` as ${data.roleName}` : '';
    const url = `${env.frontendUrl.replace(/\/$/, '')}/invites`;
    return {
      subject: `You've been invited to ${store}`,
      ...wrap(
        `<p>Hi,</p>
<p>You've been invited to join <strong>${store}</strong>${role} on Store Builder.</p>
<p><a href="${url}">View the invitation</a></p>
<p>If you don't have an account yet, sign up with this email address and the invite will be waiting for you.</p>`,
        `Hi,\n\nYou've been invited to join ${store}${role} on Store Builder.\nView the invitation: ${url}`
      ),
    };
  },
};

function render(template, data) {
  const fn = templates[template];
  if (fn) return fn(data);
  // Fallback so an untemplated notification still sends rather than throwing.
  const lines = Object.entries(data || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    subject: template.replace(/[_-]+/g, ' '),
    ...wrap(`<p>${template}</p><pre>${lines}</pre>`, `${template}\n\n${lines}`),
  };
}

module.exports = { render, wrap, SPAM_FOOTER, TEMPLATE_NAMES: Object.keys(templates) };
