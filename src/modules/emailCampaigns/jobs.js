'use strict';

const MINUTE = 60 * 1000;

// Email campaigns (campaignSender.js): the batches, and the minute tick that
// starts scheduled campaigns and keeps sending ones moving. Both do nothing
// while EMAIL_CAMPAIGNS_ENABLED is off.
const sender = () => require('./campaignSender');

module.exports = {
  processors: [{ queue: 'notifications', name: 'email_campaigns.send_batch', handle: (job) => sender().sendBatch(job.payload.campaignId) }],
  schedules: [{ name: 'email_campaigns.tick', everyMs: MINUTE, handle: () => sender().tick() }],
};
