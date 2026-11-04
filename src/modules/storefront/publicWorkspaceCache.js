'use strict';

const env = require('../../config/env');

/**
 * The heavy part of resolving a public store (core/middleware/publicWorkspace):
 * the whole workspace row, with its settings and theme, and its access picture
 * (the subscription and wallet reads). Every /store/* request made those reads;
 * with PUBLIC_WORKSPACE_CACHE_TTL_SECONDS above 0 a request makes one narrow
 * read of the row's id, status and updated_at instead, and reuses them while
 * those still match, for at most the TTL.
 *
 * That narrow read is why a suspension needs no message between API instances:
 * it changes the status, so every instance's next request sees it, whatever is
 * kept here. A write to the row bumps updated_at the same way. What can run
 * behind by the TTL is only the access picture's other inputs on another
 * instance: a subscription or wallet change, or a period ending by the clock.
 * On this instance those drop the entry at once (storefrontCache.invalidate).
 *
 * Each request gets its own copy, so one that changes what it reads changes
 * nothing for the next. Entries live in this process's memory, at most
 * MAX_ENTRIES of them, oldest out first.
 *
 * Off (0, the default): nothing is kept, and publicWorkspace reads as it always did.
 */

const MAX_ENTRIES = 500;
const entries = new Map(); // ref (the id or the slug it was asked by) -> { id, status, updatedAt, expiresAt, row, access }
const refsOf = new Map(); // workspace id -> Set of refs

const ttlMs = () => Math.max(0, Number(env.storefrontPerf.workspaceCacheTtlSeconds) || 0) * 1000;
const enabled = () => ttlMs() > 0;

/** What was kept for this ref, if it is still good for the row as it stands now. */
function read(ref, current) {
  const entry = entries.get(ref);
  if (!entry) return null;
  const same =
    entry.id === current.id &&
    entry.status === current.status &&
    new Date(entry.updatedAt).getTime() === new Date(current.updatedAt).getTime() &&
    entry.expiresAt > Date.now();
  if (!same) {
    forget(ref, entry.id);
    return null;
  }
  return { row: structuredClone(entry.row), access: structuredClone(entry.access) };
}

function write(ref, workspace, access) {
  if (entries.has(ref)) forget(ref, entries.get(ref).id);
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    forget(oldest, entries.get(oldest).id);
  }
  const row = workspace.get({ plain: true });
  entries.set(ref, {
    id: workspace.id,
    status: workspace.status,
    updatedAt: workspace.updatedAt,
    expiresAt: Date.now() + ttlMs(),
    row: structuredClone(row),
    access: structuredClone(access),
  });
  if (!refsOf.has(workspace.id)) refsOf.set(workspace.id, new Set());
  refsOf.get(workspace.id).add(ref);
}

function forget(ref, id) {
  entries.delete(ref);
  const refs = refsOf.get(id);
  if (!refs) return;
  refs.delete(ref);
  if (refs.size === 0) refsOf.delete(id);
}

/** Everything kept for a store, by whichever address it was asked. Called by storefrontCache.invalidate. */
function drop(workspaceId) {
  for (const ref of [...(refsOf.get(workspaceId) || [])]) forget(ref, workspaceId);
}

/** Forgets everything. For tests. */
function _reset() {
  entries.clear();
  refsOf.clear();
}

module.exports = { enabled, read, write, drop, _reset, MAX_ENTRIES };
