'use strict';

const env = require('../../config/env');

// Renders transactional emails to { subject, html, text }. Every template
// goes through `wrap`, which appends the shared spam-folder footer.

const SPAM_FOOTER =
  "Didn't get this email? Check your spam/junk folder and mark it as 'not spam' so future emails land in your inbox.";

const SPAM_FOOTER_AR =
  'لم تصلك هذه الرسالة في البريد الوارد؟ ابحث عنها في مجلد الرسائل غير المرغوب فيها وحدّدها بأنها ليست كذلك لتصلك رسائلنا القادمة.';

// The platform's own emails to its users (accounts, security, the merchant's
// notifications and reports): the only ones that take the sender name, the
// signature and the footer links set in the console (platformSettings,
// PLATFORM_SETTINGS_ENABLED; the sender name in notify.js). A store's emails
// to its shoppers never do, and keep the sender name they had.
const PLATFORM_TEMPLATES = new Set([
  'signup_code',
  'account_reauth_code',
  'email_change_code',
  'email_changed',
  'email_verification',
  'password_reset',
  'workspace_invite',
  'login_code',
  'security_notice',
  'email_change_confirm',
  'email_change_requested',
  'merchant_notification',
  'summary_report',
]);

// The console's signature and footer links for the email being rendered, set
// by `render` for its (synchronous) duration only; null for every other email.
let branding = null;

const SOCIAL_NAMES = {
  en: { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn', whatsapp: 'WhatsApp' },
  ar: { instagram: 'إنستغرام', facebook: 'فيسبوك', tiktok: 'تيك توك', youtube: 'يوتيوب', x: 'إكس', linkedin: 'لينكدإن', whatsapp: 'واتساب' },
};

/** The signature (in the email's language, else the other one) and the footer links, as HTML and as text. */
function brandingBlock(dir) {
  if (!branding) return { html: '', text: '' };
  const lang = dir === 'rtl' ? 'ar' : 'en';
  const signature = branding.signature ? branding.signature[lang] || branding.signature[lang === 'ar' ? 'en' : 'ar'] || '' : '';
  const links = [
    ...(branding.supportEmail ? [{ label: lang === 'ar' ? 'الدعم' : 'Support', href: `mailto:${branding.supportEmail}`, shown: branding.supportEmail }] : []),
    ...(branding.socialLinks || []).map((link) => ({ label: SOCIAL_NAMES[lang][link.platform] || link.platform, href: link.url, shown: link.url })),
  ];
  const html = [
    signature ? `<p style="margin:20px 0 0">${escapeHtml(signature).replace(/\n/g, '<br />')}</p>` : '',
    links.length
      ? `<p style="font-size:13px;color:#6b7280;margin:12px 0 0">${links.map((l) => `<a href="${escapeHtml(l.href)}" style="color:#6b7280">${escapeHtml(l.label)}</a>`).join(' · ')}</p>`
      : '',
  ].join('');
  const text = [signature, ...links.map((l) => `${l.label}: ${l.shown}`)].filter(Boolean).join('\n');
  return { html: html ? `\n${html}` : '', text: text ? `\n\n${text}` : '' };
}

// `arabicFooter` puts the Arabic footer first; the English one is on every
// email either way.
function wrap(bodyHtml, bodyText, { dir = 'ltr', arabicFooter = false } = {}) {
  const arabicHtml = arabicFooter
    ? `<p dir="rtl" style="font-size:13px;color:#6b7280;margin:0 0 8px">${SPAM_FOOTER_AR}</p>\n`
    : '';
  const own = brandingBlock(dir);
  const html = `<div dir="${dir}" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
${bodyHtml}${own.html}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 16px" />
${arabicHtml}<p dir="ltr" style="font-size:13px;color:#6b7280;margin:0">${SPAM_FOOTER}</p>
</div>`;
  const text = `${bodyText}${own.text}\n\n---\n${arabicFooter ? `${SPAM_FOOTER_AR}\n` : ''}${SPAM_FOOTER}`;
  return { html, text };
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** A code email in the account's language, like signup_code: no link anywhere. */
function codeEmail(data, copy) {
  const code = String(data.code || '');
  const minutes = Number(data.minutes) || 10;
  const codeHtml = `<p dir="ltr" style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>`;
  if (data.locale === 'en') {
    return {
      subject: copy.en.subject,
      ...wrap(
        `<p>${copy.en.intro}</p>
${codeHtml}
<p>It is valid for ${minutes} minutes and works once.</p>
<p style="color:#6b7280">If you didn't ask for this code, ignore this email: nothing changes without it.</p>`,
        `${copy.en.intro} ${code}\n\nIt is valid for ${minutes} minutes and works once.\n\nIf you didn't ask for this code, ignore this email: nothing changes without it.`
      ),
    };
  }
  return {
    subject: copy.ar.subject,
    ...wrap(
      `<p>${copy.ar.intro}</p>
${codeHtml}
<p>الرمز صالح لمدة ${minutes} دقائق ولمرة واحدة فقط.</p>
<p style="color:#6b7280">إذا لم تطلب هذا الرمز فتجاهل هذه الرسالة: لن يتغير شيء من دونه.</p>`,
      `${copy.ar.intro} ${code}\n\nالرمز صالح لمدة ${minutes} دقائق ولمرة واحدة فقط.\n\nإذا لم تطلب هذا الرمز فتجاهل هذه الرسالة: لن يتغير شيء من دونه.`,
      { dir: 'rtl', arabicFooter: true }
    ),
  };
}

const link = (path, token) =>
  `${env.frontendUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

const templates = {
  // The sign-up code (otp/verificationCodeService), in the language the
  // person signed up in. Deliberately no link anywhere: the code is typed
  // into the page that asked for it.
  signup_code(data = {}) {
    const code = String(data.code || '');
    const minutes = Number(data.minutes) || 10;
    const codeHtml = `<p dir="ltr" style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>`;
    if (data.locale === 'en') {
      return {
        subject: 'Your Zimos verification code',
        ...wrap(
          `<p>Your code to confirm your Zimos account:</p>
${codeHtml}
<p>It is valid for ${minutes} minutes and works once.</p>
<p style="color:#6b7280">If you didn't ask for this code, ignore this email.</p>`,
          `Your code to confirm your Zimos account: ${code}\n\nIt is valid for ${minutes} minutes and works once.\n\nIf you didn't ask for this code, ignore this email.`
        ),
      };
    }
    return {
      subject: 'رمز تأكيد حسابك في Zimos',
      ...wrap(
        `<p>رمز تأكيد حسابك في Zimos:</p>
${codeHtml}
<p>الرمز صالح لمدة ${minutes} دقائق ولمرة واحدة فقط.</p>
<p style="color:#6b7280">إذا لم تطلب هذا الرمز فتجاهل هذه الرسالة.</p>`,
        `رمز تأكيد حسابك في Zimos: ${code}\n\nالرمز صالح لمدة ${minutes} دقائق ولمرة واحدة فقط.\n\nإذا لم تطلب هذا الرمز فتجاهل هذه الرسالة.`,
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  // Account settings (auth/accountService): a code to the current email of an
  // account with no password (made through Google), proving it is the owner
  // before its email or phone changes; and a code to the new email. No link.
  account_reauth_code(data = {}) {
    return codeEmail(data, {
      en: { subject: 'Your Zimos security code', intro: 'Your code to confirm a change to your Zimos account:' },
      ar: { subject: 'رمز الأمان لحسابك في Zimos', intro: 'رمز تأكيد تعديل حسابك في Zimos:' },
    });
  },

  email_change_code(data = {}) {
    return codeEmail(data, {
      en: { subject: 'Confirm your new email for Zimos', intro: 'Your code to make this the email of your Zimos account:' },
      ar: { subject: 'تأكيد بريدك الإلكتروني الجديد في Zimos', intro: 'رمز اعتماد هذا البريد بريدًا لحسابك في Zimos:' },
    });
  },

  // To the OLD address once the email has changed: Arabic and English
  // together, no link at all (a link in a "your email changed" message is
  // exactly what a phishing copy would carry), the new address masked.
  email_changed(data = {}) {
    const to = escapeHtml(String(data.newEmailMasked || ''));
    const when = escapeHtml(String(data.at || ''));
    return {
      subject: 'تم تغيير بريد حسابك في Zimos — Your Zimos email was changed',
      ...wrap(
        `<div dir="rtl">
<p>تم تغيير البريد الإلكتروني لحسابك في Zimos إلى <span dir="ltr">${to}</span> (${when}). لم يعد هذا البريد يُستخدم لتسجيل الدخول.</p>
<p>إذا لم تقم أنت بهذا التغيير، فتواصل مع دعم Zimos فورًا من صفحة الدعم في موقعنا، ولا تضغط أي رابط يصلك برسالة تدّعي ذلك.</p>
</div>
<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0" />
<div dir="ltr">
<p>The email of your Zimos account was changed to ${to} (${when}). This address no longer signs you in.</p>
<p>If you didn't make this change, contact Zimos support right away through the support page on our website. Don't click any link in a message claiming to fix it.</p>
</div>`,
        `تم تغيير البريد الإلكتروني لحسابك في Zimos إلى ${data.newEmailMasked || ''} (${data.at || ''}). لم يعد هذا البريد يُستخدم لتسجيل الدخول.\nإذا لم تقم أنت بهذا التغيير، فتواصل مع دعم Zimos فورًا من صفحة الدعم في موقعنا.\n\nThe email of your Zimos account was changed to ${data.newEmailMasked || ''} (${data.at || ''}). This address no longer signs you in.\nIf you didn't make this change, contact Zimos support right away through the support page on our website.`,
        { arabicFooter: true }
      ),
    };
  },

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

  // The reset link (auth/authService.requestPasswordReset), in the language
  // the request was made in; Arabic unless it says en.
  password_reset(data = {}) {
    const url = link('/reset-password', data.token || '');
    const minutes = Number(data.minutes) || 30;
    const fullName = data.fullName ? escapeHtml(data.fullName) : '';
    if (data.locale === 'en') {
      const name = fullName ? `Hi ${fullName},` : 'Hi,';
      return {
        subject: 'Reset your password',
        ...wrap(
          `<p>${name}</p>
<p>We got a request to reset your Zimos password. This link is valid for ${minutes} minutes and works once:</p>
<p><a href="${url}">Reset my password</a></p>
<p>If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
          `${name}\n\nWe got a request to reset your Zimos password. This link is valid for ${minutes} minutes and works once:\n${url}\n\nIf you didn't ask for this, you can ignore this email.`
        ),
      };
    }
    const name = fullName ? `مرحبًا ${fullName}،` : 'مرحبًا،';
    return {
      subject: 'إعادة تعيين كلمة المرور',
      ...wrap(
        `<p>${name}</p>
<p>تلقّينا طلبًا لإعادة تعيين كلمة مرور حسابك في Zimos. هذا الرابط صالح لمدة ${minutes} دقيقة ولمرة واحدة فقط:</p>
<p><a href="${url}">إعادة تعيين كلمة المرور</a></p>
<p>إذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن تتغير كلمة مرورك.</p>`,
        `${name}\n\nتلقّينا طلبًا لإعادة تعيين كلمة مرور حسابك في Zimos. هذا الرابط صالح لمدة ${minutes} دقيقة ولمرة واحدة فقط:\n${url}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة.`,
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  // workspaces/workspaceService inviteMember. With `token`: a pending invite,
  // accepted on the dashboard's /invites page (workspaces/inviteAcceptance).
  // Without: an existing account that was added at once.
  workspace_invite(data = {}) {
    const store = data.workspaceName || 'a store';
    const role = data.roleName ? ` as ${data.roleName}` : '';
    const storeHtml = escapeHtml(store);
    const roleHtml = data.roleName ? ` as ${escapeHtml(data.roleName)}` : '';
    if (!data.token) {
      const url = `${env.frontendUrl.replace(/\/$/, '')}/workspaces`;
      return {
        subject: `You've been added to ${store}`,
        ...wrap(
          `<p>Hi,</p>
<p>You've been added to <strong>${storeHtml}</strong>${roleHtml} on Zimos.</p>
<p><a href="${url}">Open your stores</a></p>`,
          `Hi,\n\nYou've been added to ${store}${role} on Zimos.\nOpen your stores: ${url}`
        ),
      };
    }
    const url = link('/invites', data.token);
    const days = Number(data.expiresInDays) || 7;
    const email = data.email ? String(data.email) : '';
    const withEmail = email ? ` with ${email}` : '';
    const withEmailHtml = email ? ` with <strong>${escapeHtml(email)}</strong>` : '';
    return {
      subject: `You've been invited to ${store}`,
      ...wrap(
        `<p>Hi,</p>
<p>You've been invited to join <strong>${storeHtml}</strong>${roleHtml} on Zimos.</p>
<p><a href="${url}">Accept the invitation</a></p>
<p>Sign in${withEmailHtml}, or create an account${withEmailHtml} if you don't have one yet. The link works for ${days} days and only once.</p>`,
        `Hi,\n\nYou've been invited to join ${store}${role} on Zimos.\nAccept the invitation: ${url}\n\nSign in${withEmail}, or create an account${withEmail} if you don't have one yet. The link works for ${days} days and only once.`
      ),
    };
  },

  // The second step of a sign-in (modules/auth/twoFactorService.js).
  login_code(data = {}) {
    const code = String(data.code || '');
    const minutes = Number(data.minutes) || 10;
    const codeHtml = `<p dir="ltr" style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>`;
    if (data.locale === 'en') {
      return {
        subject: 'Your Zimos sign-in code',
        ...wrap(
          `<p>Someone is signing in to your Zimos account from a new device. Enter this code to finish:</p>
${codeHtml}
<p>It is valid for ${minutes} minutes and works once.</p>
<p style="color:#6b7280">If this was not you, change your password now: someone knows it.</p>`,
          `Your Zimos sign-in code: ${code}\n\nIt is valid for ${minutes} minutes and works once.\n\nIf this was not you, change your password now.`
        ),
      };
    }
    return {
      subject: 'رمز تسجيل الدخول إلى Zimos',
      ...wrap(
        `<p>في محاولة تسجيل دخول لحسابك على Zimos من جهاز جديد. اكتب الرمز ده عشان تكمل:</p>
${codeHtml}
<p>الرمز صالح لمدة ${minutes} دقائق ويُستخدم مرة واحدة.</p>
<p style="color:#6b7280">لو مش إنت، غيّر كلمة السر حالًا: في حد عارفها.</p>`,
        `رمز تسجيل الدخول إلى Zimos: ${code}\n\nصالح لمدة ${minutes} دقائق ويُستخدم مرة واحدة.\n\nلو مش إنت، غيّر كلمة السر حالًا.`
      ),
    };
  },

  // Something changed in how the person signs in (auth/twoFactorRecovery.js,
  // auth/newDeviceSignIn.js). `kind` picks the text; no link, nothing to click.
  security_notice(data = {}) {
    const left = Number(data.left) || 0;
    const en = data.locale === 'en';
    const texts = {
      backup_code_used: en
        ? ['A backup code was used on your Zimos account', `Someone signed in to your Zimos account with one of your backup codes. You have ${left} left.`]
        : ['تم استخدام رمز احتياطي في حسابك على Zimos', `حد سجّل دخول لحسابك على Zimos بواحد من الرموز الاحتياطية. فاضل معاك ${left}.`],
      two_factor_reset: en
        ? ['Two-step sign-in was turned off on your Zimos account', 'At your request, the Zimos team turned off two-step sign-in on your account and signed you out everywhere. Sign in and turn it back on from Settings → Security.']
        : ['تم إيقاف التحقق بخطوتين في حسابك على Zimos', 'بناءً على طلبك، فريق Zimos وقّف التحقق بخطوتين في حسابك وسجّل خروجك من كل الأجهزة. سجّل دخول وشغّله تاني من الإعدادات ← الأمان.'],
    };
    // A sign-in from a browser new to the account (newDeviceSignIn.js).
    const where = [data.device, data.ip].filter(Boolean).map(String).join(' · ');
    const when = data.at ? new Date(data.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
    texts.new_sign_in = en
      ? ['New sign-in to your Zimos account', `Your Zimos account was just signed in to from a new browser: ${where || 'unknown browser'}${when ? `, ${when}` : ''}. If this was you, there is nothing to do. If not, change your password now and end that session from Settings → Security.`]
      : ['تسجيل دخول جديد لحسابك على Zimos', `حسابك على Zimos اتسجّل دخوله دلوقتي من متصفح جديد: ${where || 'متصفح غير معروف'}${when ? `، ${when}` : ''}. لو ده إنت، مفيش حاجة تعملها. لو مش إنت، غيّر كلمة السر حالًا وأنهِ الجلسة دي من الإعدادات ← الأمان.`];
    const [subject, line] = texts[data.kind] || texts.two_factor_reset;
    const warn = en ? 'If this was not you, change your password now and contact support.' : 'لو مش إنت، غيّر كلمة السر حالًا وكلّم الدعم.';
    return {
      subject,
      ...wrap(`<p>${escapeHtml(line)}</p>\n<p style="color:#6b7280">${escapeHtml(warn)}</p>`, `${line}\n\n${warn}`, { dir: en ? 'ltr' : 'rtl' }),
    };
  },

  // A store's email to its customer about an order (orderEmailService.js):
  // the merchant's subject and text under the store's logo and colour.
  order_email(data = {}) {
    const subject = String(data.subject || data.storeName || '');
    const color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : '#2563EB';
    const store = escapeHtml(data.storeName || '');
    // Plain text in, safe HTML out: escaped, links made clickable, blank lines as paragraphs.
    const linkify = (text) => text.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" style="color:${color}">${url}</a>`);
    // A block-designed email arrives already rendered and escaped (emailBlocks.js renderBlocks).
    const paragraphs = data.bodyHtml
      ? String(data.bodyHtml)
      : String(data.body || '')
          .split(/\n{2,}/)
          .map((p) => `<p style="margin:0 0 14px">${linkify(escapeHtml(p)).replace(/\n/g, '<br />')}</p>`)
          .join('\n');
    const logo = data.logoUrl && /^https?:\/\//.test(data.logoUrl) ? `<img src="${escapeHtml(data.logoUrl)}" alt="${store}" style="max-height:48px;max-width:180px" />` : `<strong style="font-size:18px">${store}</strong>`;
    // A marketing email (the abandoned cart) ends with its unsubscribe link (marketingUnsubscribe.js).
    const unsubscribe = data.unsubscribeUrl && /^https?:\/\//.test(data.unsubscribeUrl) ? String(data.unsubscribeUrl) : null;
    const unsubscribeHtml = unsubscribe
      ? `\n<p style="font-size:13px;color:#6b7280;margin:14px 0 0">لا تريد رسائل تسويقية من ${store}؟ <a href="${escapeHtml(unsubscribe)}" style="color:#6b7280">إلغاء الاشتراك</a></p>`
      : '';
    return {
      subject,
      ...wrap(
        `<div style="border-top:4px solid ${color};padding-top:18px;margin-bottom:18px">${logo}</div>
${paragraphs}
<p style="color:#6b7280;margin:18px 0 0">${store}</p>${unsubscribeHtml}`,
        [data.bodyText || data.body, data.storeName, unsubscribe && `إلغاء الاشتراك من الرسائل التسويقية: ${unsubscribe}`].filter(Boolean).join('\n\n'),
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  // An automation's email step (modules/automations): the merchant's own
  // subject and text, to their customer, signed with the store's name.
  automation_message(data = {}) {
    const subject = String(data.subject || data.storeName || '');
    const paragraphs = String(data.body || '')
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
      .join('\n');
    const signature = data.storeName ? `<p style="color:#6b7280">${escapeHtml(data.storeName)}</p>` : '';
    return {
      subject,
      ...wrap(`${paragraphs}\n${signature}`, [data.body, data.storeName].filter(Boolean).join('\n\n'), { dir: 'rtl', arabicFooter: true }),
    };
  },

  // A merchant notification sent by email (merchantNotificationService): the
  // same title and body the dashboard bell shows, with a link to the page.
  // Changing the sign-in email (auth/emailChange.js): the link to the new
  // address, and the two notices to the old one. Arabic first, then English.
  email_change_confirm(data = {}) {
    const url = link('/account/email-change', data.token || '');
    const to = escapeHtml(data.newEmail || '');
    return {
      subject: 'أكّد بريدك الجديد في Zimos — Confirm your new Zimos email',
      ...wrap(
        `<p dir="rtl">طلبت تغيير بريد الدخول لحسابك في Zimos إلى <strong>${to}</strong>. افتح الرابط خلال ٢٤ ساعة لتأكيده:</p>
<p><a href="${url}">تأكيد البريد الجديد — Confirm my new email</a></p>
<p dir="ltr">You asked to change the email you sign in to Zimos with to <strong>${to}</strong>. Open the link within 24 hours to confirm it. If you didn't ask for this, ignore this email.</p>
<p dir="ltr" style="color:#6b7280">${url}</p>`,
        `طلبت تغيير بريد الدخول لحسابك في Zimos إلى ${data.newEmail}. افتح الرابط خلال ٢٤ ساعة لتأكيده:\n${url}\n\nYou asked to change your Zimos sign-in email to ${data.newEmail}. Confirm within 24 hours:\n${url}`,
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  email_change_requested(data = {}) {
    const to = escapeHtml(data.newEmail || '');
    return {
      subject: 'طلب تغيير بريد حسابك في Zimos — Zimos email change requested',
      ...wrap(
        `<p dir="rtl">طُلب تغيير بريد الدخول لحسابك إلى <strong>${to}</strong>. لن يتغيّر شيء حتى يُفتح رابط التأكيد المرسل إلى العنوان الجديد. إذا لم تطلب ذلك فغيّر كلمة مرورك.</p>
<p dir="ltr">Someone asked to change your Zimos sign-in email to <strong>${to}</strong>. Nothing changes until the link sent to that address is opened. If this wasn't you, change your password.</p>`,
        `طُلب تغيير بريد الدخول لحسابك إلى ${data.newEmail}. إذا لم تطلب ذلك فغيّر كلمة مرورك.\n\nSomeone asked to change your Zimos sign-in email to ${data.newEmail}. If this wasn't you, change your password.`,
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  email_changed(data = {}) {
    const to = escapeHtml(data.newEmail || '');
    return {
      subject: 'تم تغيير بريد حسابك في Zimos — Your Zimos email was changed',
      ...wrap(
        `<p dir="rtl">أصبح بريد الدخول لحسابك في Zimos <strong>${to}</strong>. إذا لم تقم بذلك فتواصل مع الدعم فورًا.</p>
<p dir="ltr">Your Zimos sign-in email is now <strong>${to}</strong>. If you didn't do this, contact support right away.</p>`,
        `أصبح بريد الدخول لحسابك في Zimos ${data.newEmail}.\n\nYour Zimos sign-in email is now ${data.newEmail}. If you didn't do this, contact support right away.`,
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },

  // A sold-out product is back (modules/stockAlerts): its name and a link, the store's name.
  back_in_stock(data = {}) {
    const name = escapeHtml(String(data.productName || '').slice(0, 300));
    const store = escapeHtml(String(data.storeName || '').slice(0, 120));
    const url = /^https?:\/\//.test(String(data.url || '')) ? String(data.url) : '';
    const button = url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${data.locale === 'en' ? 'Order now' : 'اطلبه دلوقتي'}</a></p>` : '';
    if (data.locale === 'en') return { subject: `${data.productName} is back in stock`, ...wrap(`<p><b>${name}</b> is back in stock at ${store}.</p>${button}<p style="color:#6b7280">You asked to be told once; we won't write again about it.</p>`, `${data.productName} is back in stock at ${data.storeName}: ${url}`) };
    return { subject: `${data.productName} رجع متاح`, ...wrap(`<p><b>${name}</b> رجع متاح في ${store}.</p>${button}<p style="color:#6b7280">طلبت نبلغك مرة واحدة، ومش هنبعتلك تاني عنه.</p>`, `${data.productName} رجع متاح في ${data.storeName}: ${url}`, { dir: 'rtl', arabicFooter: true }) };
  },

  // The store answered a shopper's question on a product (modules/productQuestions): once, to the asker.
  question_answered(data = {}) {
    const name = escapeHtml(String(data.productName || '').slice(0, 300));
    const store = escapeHtml(String(data.storeName || '').slice(0, 120));
    const q = escapeHtml(String(data.question || '').slice(0, 1000));
    const a = escapeHtml(String(data.answer || '').slice(0, 3000)).replace(/\n/g, '<br />');
    const url = /^https?:\/\//.test(String(data.url || '')) ? String(data.url) : '';
    const link = url ? `<p><a href="${escapeHtml(url)}">${data.locale === 'en' ? 'See the product' : 'شوف المنتج'}</a></p>` : '';
    if (data.locale === 'en') return { subject: `${data.storeName || ''} answered your question`, ...wrap(`<p>${store} answered your question about <b>${name}</b>:</p><p style="color:#6b7280">${q}</p><p>${a}</p>${link}`, `${data.question}\n\n${data.answer}\n\n${url}`) };
    return { subject: `${data.storeName || ''} رد على سؤالك`, ...wrap(`<p>${store} رد على سؤالك عن <b>${name}</b>:</p><p style="color:#6b7280">${q}</p><p>${a}</p>${link}`, `${data.question}\n\n${data.answer}\n\n${url}`, { dir: 'rtl', arabicFooter: true }) };
  },

  // A gift card sent to its holder (modules/giftCards): the code, the value, the store's name.
  gift_card(data = {}) {
    const store = escapeHtml(String(data.storeName || '').slice(0, 120));
    const code = escapeHtml(String(data.code || ''));
    const value = `${escapeHtml(String(data.amount || ''))} ${escapeHtml(String(data.currency || ''))}`;
    const note = data.message ? `<p style="padding:12px;background:#f6f6f6;border-radius:8px">${escapeHtml(String(data.message).slice(0, 500))}</p>` : '';
    const codeHtml = `<p dir="ltr" style="font-size:24px;font-weight:700;letter-spacing:3px;margin:20px 0;font-family:ui-monospace,Menlo,Consolas,monospace">${code}</p>`;
    const until = data.expiresAt ? new Date(data.expiresAt).toISOString().slice(0, 10) : null;
    if (data.locale === 'en') {
      return { subject: `Your ${data.storeName || ''} gift card`, ...wrap(`<p>${data.recipientName ? `Hi ${escapeHtml(data.recipientName)},` : 'Hi,'}</p><p>Here is your gift card for ${store}, worth <b>${value}</b>.</p>${note}${codeHtml}<p>Type this code at checkout.${until ? ` Valid until ${until}.` : ''}</p>`, `Your gift card for ${data.storeName}: ${data.code} (${value}).${until ? ` Valid until ${until}.` : ''}`) };
    }
    return { subject: `كارت هدية من ${data.storeName || ''}`, ...wrap(`<p>${data.recipientName ? `أهلًا ${escapeHtml(data.recipientName)}،` : 'أهلًا،'}</p><p>ده كارت هدية من ${store} بقيمة <b>${value}</b>.</p>${note}${codeHtml}<p>اكتب الكود ده في صفحة الدفع.${until ? ` صالح لحد ${until}.` : ''}</p>`, `كارت هدية من ${data.storeName}: ${data.code} (${value}).${until ? ` صالح لحد ${until}.` : ''}`, { dir: 'rtl', arabicFooter: true }) };
  },

  // A shopper's sign-in code to a store (modules/shopperAccounts): the store's name, not Zimos.
  shopper_login_code(data = {}) {
    const code = String(data.code || '');
    const minutes = Number(data.minutes) || 10;
    const store = escapeHtml(String(data.storeName || '').slice(0, 120));
    const codeHtml = `<p dir="ltr" style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</p>`;
    if (data.locale === 'en') {
      return {
        subject: `Your sign-in code for ${data.storeName || 'the store'}`,
        ...wrap(`<p>Your code to sign in to ${store}:</p>\n${codeHtml}\n<p>It is valid for ${minutes} minutes and works once. If you didn't ask for it, ignore this email.</p>`, `Your code to sign in to ${data.storeName}: ${code}\n\nIt is valid for ${minutes} minutes and works once.`),
      };
    }
    return {
      subject: `رمز الدخول إلى ${data.storeName || 'المتجر'}`,
      ...wrap(`<p>رمز الدخول إلى ${store}:</p>\n${codeHtml}\n<p>الرمز صالح لمدة ${minutes} دقائق ولمرة واحدة. إذا لم تطلبه فتجاهل هذه الرسالة.</p>`, `رمز الدخول إلى ${data.storeName}: ${code}\n\nالرمز صالح لمدة ${minutes} دقائق ولمرة واحدة.`, { dir: 'rtl', arabicFooter: true }),
    };
  },

  // The daily / weekly summary to a team member (modules/scheduledReports), in their dashboard language.
  summary_report(data = {}) {
    const en = data.locale === 'en';
    const money = (v) => (v === null || v === undefined ? '—' : `${(Number(v) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${data.currency || ''}`.trim());
    const show = (m) => (m.value === null || m.value === undefined ? '—' : m.type === 'money' ? money(m.value) : m.type === 'rate' ? `${m.value}%` : String(m.value));
    const delta = (m) => {
      const n = m.type === 'rate' ? m.changePoints : m.changePercent;
      if (n === null || n === undefined) return '';
      const sign = n > 0 ? '+' : '';
      return m.type === 'rate' ? `${sign}${n} ${en ? 'pts' : 'نقطة'}` : `${sign}${n}%`;
    };
    const day = (iso) => String(iso || '').slice(0, 10);
    const weekly = data.kind === 'weekly';
    const title = en ? `${weekly ? 'Weekly' : 'Daily'} summary — ${data.storeName || ''}` : `ملخص ${weekly ? 'الأسبوع' : 'اليوم'} — ${data.storeName || ''}`;
    const range = weekly ? `${data.fromDay || day(data.from)} → ${data.lastDay || day(data.to)}` : data.fromDay || day(data.from);
    const vs = en ? (weekly ? 'vs. the week before' : 'vs. the day before') : weekly ? 'مقارنة بالأسبوع اللي قبله' : 'مقارنة باليوم اللي قبله';
    const rows = (data.metrics || [])
      .map((m) => `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">${escapeHtml(m.label[en ? 'en' : 'ar'])}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:bold">${escapeHtml(show(m))}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#6b7280">${escapeHtml(delta(m))}</td></tr>`)
      .join('');
    const top = (data.topProducts || []).length
      ? `<h3 style="font-size:16px;margin:20px 0 8px">${en ? 'Top products' : 'أكتر المنتجات مبيعًا'}</h3><ol style="margin:0;padding-inline-start:20px">${data.topProducts.map((p) => `<li>${escapeHtml(p.name)} — ${escapeHtml(String(p.quantity))} × · ${escapeHtml(money(p.sales))}</li>`).join('')}</ol>`
      : '';
    const link = data.url ? `<p style="margin:20px 0 0"><a href="${escapeHtml(data.url)}">${en ? 'Open the dashboard' : 'افتح لوحة التحكم'}</a></p>` : '';
    const text = [title, range, '', ...(data.metrics || []).map((m) => `${m.label[en ? 'en' : 'ar']}: ${show(m)} ${delta(m)}`.trim()), ...(data.topProducts || []).map((p, i) => `${i + 1}. ${p.name} — ${p.quantity} × · ${money(p.sales)}`), data.url || ''].join('\n');
    return {
      subject: title,
      ...wrap(
        `<h2 style="font-size:20px;margin:0 0 4px">${escapeHtml(title)}</h2><p style="color:#6b7280;margin:0 0 16px">${escapeHtml(range)} · ${escapeHtml(vs)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px">${rows}</table>${top}${link}`,
        text,
        { dir: en ? 'ltr' : 'rtl', arabicFooter: !en }
      ),
    };
  },

  merchant_notification(data = {}) {
    const title = String(data.title || '');
    const body = data.body ? String(data.body) : '';
    const url = data.link ? `${env.frontendUrl.replace(/\/$/, '')}${data.link}` : null;
    return {
      subject: title,
      ...wrap(
        `<p><strong>${escapeHtml(title)}</strong></p>${body ? `<p>${escapeHtml(body)}</p>` : ''}${url ? `<p><a href="${url}">فتح في لوحة التحكم</a></p>` : ''}`,
        [title, body, url].filter(Boolean).join('\n\n'),
        { dir: 'rtl', arabicFooter: true }
      ),
    };
  },
};

// `platformBranding`: the console's signature and footer links
// (platformSettingsService.emailBranding), used by the platform's own emails
// only; null renders every email as before.
function render(template, data, platformBranding = null) {
  branding = platformBranding && PLATFORM_TEMPLATES.has(template) ? platformBranding : null;
  try {
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
  } finally {
    branding = null;
  }
}

module.exports = { render, wrap, SPAM_FOOTER, TEMPLATE_NAMES: Object.keys(templates), PLATFORM_TEMPLATES };
