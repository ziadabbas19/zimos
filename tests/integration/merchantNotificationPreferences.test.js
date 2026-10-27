'use strict';

// "My notifications" in the dashboard draws one column per entry of
// `channels` (notifications/merchantNotificationService.getPreferences).
// Nothing sends `push` yet, so it is not offered; a choice saved for it
// before is kept, read and still saved.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

async function owner() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken);
  return {
    auth,
    workspace,
    H: { Authorization: `Bearer ${auth.accessToken}` },
    url: `/api/v1/workspaces/${workspace.id}/notifications/preferences`,
  };
}

const stored = async (workspaceId, userId) => (await db.NotificationPreference.findOne({ where: { workspaceId, userId } })).channels;
const row = (body, type) => body.types.find((t) => t.type === type);

describe('notification preferences: the channels offered', () => {
  it('offers the bell, email and WhatsApp, not push', async () => {
    const { H, url } = await owner();
    const res = await request(app).get(url).set(H);
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual(['inApp', 'email', 'whatsapp']);
  });

  it('keeps a push choice saved before, through later saves of the other channels', async () => {
    const { auth, workspace, H, url } = await owner();
    // A tab opened before the column went away may still send it.
    const put = await request(app).put(url).set(H).send({ types: [{ type: 'order.new', push: false }] });
    expect(put.status).toBe(200);
    expect(put.body.channels).not.toContain('push');
    expect(row(put.body, 'order.new').push).toBe(false);
    expect((await stored(workspace.id, auth.userId))['order.new']).toEqual({ push: false });

    const again = await request(app).put(url).set(H).send({ types: [{ type: 'order.new', inApp: false }] });
    expect(again.status).toBe(200);
    expect((await stored(workspace.id, auth.userId))['order.new']).toEqual({ push: false, inApp: false });
    expect(row((await request(app).get(url).set(H)).body, 'order.new')).toMatchObject({ inApp: false, push: false });
  });
});
