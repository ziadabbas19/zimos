'use strict';

const { ValidationError } = require('../../core/errors/AppError');
const { validatePageTree, EMPTY_TREE } = require('../pages/pageTree');

/**
 * A funnel is a directed graph of steps. Each step's `builderData` is a page
 * tree — exactly the same structured section/row/column/element shape the page
 * engine validates, with the same "no raw HTML" guarantee — so step content
 * validation is delegated straight to `validatePageTree`.
 *
 * `validateGraph` checks the graph itself (entry, reachability, dangling
 * edges) and, on publish, that every step has real content. Like the page
 * engine it collects *all* problems and returns them so the builder UI can
 * flag each one, rather than failing on the first.
 */

const STEP_TYPES = new Set([
  'landing',
  'sales',
  'opt_in',
  'checkout',
  'upsell',
  'downsell',
  'thank_you',
  'custom',
]);

// Steps that sell an offer when the visitor accepts them.
const OFFER_STEP_TYPES = new Set(['upsell', 'downsell']);

function validateStepData(data, opts = {}) {
  return validatePageTree(data, opts);
}

/**
 * The entry step is the one no edge points at. A valid published funnel has
 * exactly one. Returns { entryKey, problems }.
 */
function resolveEntry(steps, edges) {
  const problems = [];
  const stepKeys = steps.map((s) => s.key);
  const targeted = new Set(edges.map((e) => e.toStepKey));
  const entries = stepKeys.filter((k) => !targeted.has(k));

  if (steps.length === 0) {
    problems.push({ field: 'steps', message: 'A funnel needs at least one step' });
    return { entryKey: null, problems };
  }
  if (entries.length === 0) {
    problems.push({
      field: 'steps',
      message: 'No entry step — every step is the target of an edge, so the funnel has no start. Remove the edge into your first step.',
    });
    return { entryKey: null, problems };
  }
  if (entries.length > 1) {
    problems.push({
      field: 'steps',
      message: `Multiple possible entry steps (${entries.join(', ')}). Exactly one step must have no incoming edge.`,
    });
    return { entryKey: null, problems };
  }
  return { entryKey: entries[0], problems };
}

/**
 * @param {Array} steps  [{ key, stepType, name, builderData, offerId }]
 * @param {Array} edges  [{ fromStepKey, toStepKey, condition, priority }]
 * @param {object} opts
 * @param {boolean} opts.requireContent  when true (publish), empty step trees are rejected
 * @returns {Array} problems  [] when the graph is publishable
 */
function validateGraph(steps, edges, { requireContent = false } = {}) {
  const problems = [];
  const stepKeys = new Set();
  for (const s of steps) {
    if (stepKeys.has(s.key)) {
      problems.push({ field: `steps.${s.key}`, message: `Duplicate step key "${s.key}"` });
    }
    stepKeys.add(s.key);
    if (!STEP_TYPES.has(s.stepType)) {
      problems.push({ field: `steps.${s.key}.stepType`, message: `Unknown step type "${s.stepType}"` });
    }
    if (OFFER_STEP_TYPES.has(s.stepType) && !s.offerId) {
      problems.push({
        field: `steps.${s.key}.offerId`,
        message: `A ${s.stepType} step must reference an offer`,
      });
    }
  }

  for (const [i, e] of edges.entries()) {
    if (!stepKeys.has(e.fromStepKey)) {
      problems.push({ field: `edges[${i}].fromStepKey`, message: `Edge starts at unknown step "${e.fromStepKey}"` });
    }
    if (!stepKeys.has(e.toStepKey)) {
      problems.push({ field: `edges[${i}].toStepKey`, message: `Edge points at unknown step "${e.toStepKey}"` });
    }
  }

  const { entryKey, problems: entryProblems } = resolveEntry(steps, edges);
  problems.push(...entryProblems);

  // Reachability: BFS from the entry over well-formed edges only.
  if (entryKey) {
    const adjacency = new Map();
    for (const e of edges) {
      if (!stepKeys.has(e.fromStepKey) || !stepKeys.has(e.toStepKey)) continue;
      if (!adjacency.has(e.fromStepKey)) adjacency.set(e.fromStepKey, []);
      adjacency.get(e.fromStepKey).push(e.toStepKey);
    }
    const seen = new Set([entryKey]);
    const queue = [entryKey];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of adjacency.get(cur) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const s of steps) {
      if (!seen.has(s.key)) {
        problems.push({
          field: `steps.${s.key}`,
          message: `Step "${s.key}" is unreachable from the entry step`,
        });
      }
    }
  }

  if (requireContent) {
    for (const s of steps) {
      try {
        validatePageTree(s.builderData, { requireContent: true, label: `step "${s.key}"` });
      } catch (err) {
        if (err instanceof ValidationError && Array.isArray(err.details)) {
          err.details.forEach((d) =>
            problems.push({ stepKey: s.key, field: `steps.${s.key}.${d.field}`, message: d.message })
          );
        } else {
          throw err;
        }
      }
    }
  }

  return problems;
}

module.exports = { validateStepData, validateGraph, resolveEntry, STEP_TYPES, OFFER_STEP_TYPES, EMPTY_TREE };
