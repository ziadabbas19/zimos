'use strict';

/**
 * Edge routing. A funnel edge carries an optional `condition`; when a visitor
 * finishes a step the runtime produces an `outcome` and picks the first
 * outbound edge whose condition matches, ordered by `priority` (desc) then by
 * the edge's position in the published snapshot.
 *
 * Condition grammar:
 *   { type: 'always' }              // or a null/absent condition
 *   { type: 'completed_checkout' }
 *   { type: 'accepted_offer' }      // an upsell/downsell was accepted
 *   { type: 'declined_offer' }      // an upsell/downsell was declined / skipped
 *
 * Outcome shape from the client:
 *   { type: 'completed_checkout', orderId } | { type: 'accepted_offer' }
 *   | { type: 'declined_offer' } | { type: 'clicked_through' }
 */

const CONDITION_TYPES = new Set(['always', 'completed_checkout', 'accepted_offer', 'declined_offer']);
const OUTCOME_TYPES = new Set(['completed_checkout', 'accepted_offer', 'declined_offer', 'clicked_through']);

/** @returns {string|null} an error message, or null when the condition is valid */
function conditionProblem(condition) {
  if (condition === null || condition === undefined) return null; // treated as 'always'
  if (typeof condition !== 'object' || Array.isArray(condition)) {
    return 'condition must be an object like { "type": "always" }';
  }
  if (!CONDITION_TYPES.has(condition.type)) {
    return `unknown condition type "${condition.type}" (allowed: ${[...CONDITION_TYPES].join(', ')})`;
  }
  return null;
}

function matches(condition, outcome) {
  const type = condition && condition.type ? condition.type : 'always';
  if (type === 'always') return true;
  return outcome && outcome.type === type;
}

/**
 * @param {Array} outboundEdges  edges whose fromStepKey === the current step, in snapshot order
 * @param {object} outcome
 * @returns {object|null} the chosen edge, or null when nothing matches (funnel ends)
 */
function pickNextEdge(outboundEdges, outcome) {
  const ranked = outboundEdges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => (b.edge.priority || 0) - (a.edge.priority || 0) || a.index - b.index);
  for (const { edge } of ranked) {
    if (matches(edge.condition, outcome)) return edge;
  }
  return null;
}

module.exports = { CONDITION_TYPES, OUTCOME_TYPES, conditionProblem, matches, pickNextEdge };
