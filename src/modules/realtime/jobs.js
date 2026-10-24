'use strict';

const env = require('../../config/env');
const { EVENTS } = require('./catalog');

/**
 * The outbox consumer of the live updates: each event of catalog.js goes to
 * its room through the emitter (publisher.js), from the worker.
 *
 * `events` is read at each dispatch (core/outbox consumersFor), so with
 * REALTIME_ENABLED off it lists nothing and no job is ever queued for it.
 */
module.exports = {
  consumers: [
    {
      name: 'realtime',
      queue: 'default',
      get events() {
        return env.realtime.enabled ? EVENTS : [];
      },
      handle: async (event) => {
        // eslint-disable-next-line global-require
        require('./publisher').publish(event);
      },
    },
  ],
};
