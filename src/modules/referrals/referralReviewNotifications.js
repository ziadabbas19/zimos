'use strict';

const notifications = require('../platformAdmin/platformNotificationService');

/**
 * What the console's bell says about a creator's review of referral codes and
 * store agent links (referralCodeService, agentLinkService).
 *
 * Something waiting goes to whoever can review it, those who made it aside: one
 * row per code, and per store for a link. Another change to what already waits
 * updates that row and shows it as unread again; a decision, or changing it back
 * so nothing waits, removes it. A decision goes only to the people it concerns.
 *
 * `title` is an English fallback. The console writes each of these in the
 * viewer's language from `data` (lib/notificationStrings); `body` is the reason
 * a reviewer typed, as they typed it.
 */

const nameOf = (req) => req.user.fullName || req.user.email || null;
const codeKey = (codeId) => `referral_code_review:${codeId}`;
const linkKey = (workspaceId) => `agent_link_review:${workspaceId}`;
// The store page's second tab holds its referral codes and agent.
const storeLink = (workspaceId) => `/workspaces/${workspaceId}?tab=subscription`;

/** Everyone concerned but whoever just decided: nobody is told about their own decision. */
const othersThan = (req, ids) => [...new Set(ids.filter(Boolean))].filter((id) => id !== req.user.id);

/** `change`: 'new' (it was just made) or 'change'. `authors`: who may not review it. */
function codeWaiting(code, change, authors, req, transaction) {
  return notifications.notify(
    {
      type: 'referral_code_review',
      title: change === 'new' ? `New referral code ${code.code} is waiting for review` : `A change to referral code ${code.code} is waiting for review`,
      link: `/referral-codes/${code.id}`,
      data: { codeId: code.id, code: code.code, change, actorName: nameOf(req) },
      actorUserId: req.user.id,
      hiddenFrom: authors,
      dedupeKey: codeKey(code.id),
      refresh: true,
    },
    transaction
  );
}

/** Nothing waits any more, though nobody decided: the change was taken back. */
function codeNoLongerWaiting(code, transaction) {
  return notifications.withdraw(codeKey(code.id), transaction);
}

/**
 * `decision`: 'approved' or 'rejected'. `change`: what was reviewed, as above.
 * `edited`: the reviewer changed it on the way. `concerned`: its owner and whoever
 * made or changed it.
 */
async function codeDecided(code, { decision, change, edited = false, reason = null, concerned }, req, transaction) {
  await notifications.withdraw(codeKey(code.id), transaction);
  const recipients = othersThan(req, concerned);
  if (recipients.length === 0) return;
  await notifications.notify(
    {
      type: 'referral_code_decided',
      title: `Referral code ${code.code} was ${decision}${edited ? ' after being edited' : ''}`,
      body: reason,
      link: `/referral-codes/${code.id}`,
      data: { codeId: code.id, code: code.code, decision, change, edited, actorName: nameOf(req) },
      actorUserId: req.user.id,
      recipients,
    },
    transaction
  );
}

const linkData = (request, req) => ({
  requestId: request.id,
  name: (request.workspace && request.workspace.name) || null,
  kind: request.kind,
  agentName: (request.agent && request.agent.fullName) || null,
  actorName: nameOf(req),
});

/** `request` as agentLinkService serializes it. */
function linkWaiting(request, req, transaction) {
  const data = linkData(request, req);
  return notifications.notify(
    {
      type: 'agent_link_review',
      title: `A change to the agent of ${data.name || 'a store'} is waiting for review`,
      link: storeLink(request.workspaceId),
      data,
      actorUserId: req.user.id,
      workspaceId: request.workspaceId,
      hiddenFrom: request.authorIds,
      dedupeKey: linkKey(request.workspaceId),
      refresh: true,
    },
    transaction
  );
}

/** `request` as agentLinkService serializes it, already decided. Told to whoever asked. */
async function linkDecided(request, requestedByUserId, req, transaction) {
  await notifications.withdraw(linkKey(request.workspaceId), transaction);
  const recipients = othersThan(req, [requestedByUserId]);
  if (recipients.length === 0) return;
  const data = { ...linkData(request, req), decision: request.status };
  await notifications.notify(
    {
      type: 'agent_link_decided',
      title: `The change to the agent of ${data.name || 'a store'} was ${request.status}`,
      body: request.reason,
      link: storeLink(request.workspaceId),
      data,
      actorUserId: req.user.id,
      workspaceId: request.workspaceId,
      recipients,
    },
    transaction
  );
}

module.exports = { codeWaiting, codeNoLongerWaiting, codeDecided, linkWaiting, linkDecided };
