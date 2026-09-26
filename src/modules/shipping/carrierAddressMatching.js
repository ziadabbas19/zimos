'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { isCityDistrict } = require('./carriers/adapterContract');

/**
 * Maps an order's free-text address (province + city, as the storefront
 * collected it) onto a carrier's address tree: one node per level, top first
 * (capabilities.addressLevels), the leaf being what a parcel is booked to.
 *
 * In Egyptian order data `province` is the governorate — the top level (what
 * Bosta calls the city: Cairo, Giza, Alexandria) — and `city` is the area
 * (Bosta's district: Nasr City, Maadi, 15 May). The province picks the top
 * node; the area is then looked for among its children and, when the carrier
 * has more levels, further down. A level the order's text doesn't reach is
 * the merchant's to choose.
 *
 * The rule is: send an id only on an exact match after normalisation, and
 * only when exactly one row matches. Anything else is the merchant's call: a
 * 422 CARRIER_ADDRESS_UNMATCHED with the candidates, and they resend with
 * explicit ids. A guessed district is a parcel driven to the wrong area.
 *
 * Normalisation, both sides the same:
 *  1. zimos_normalize_search (migration 088) — run in SQL, the one definition
 *     of the Arabic folding the order search already uses: alef forms -> ا,
 *     ة -> ه, ى -> ي, tashkeel/tatweel dropped, lower-cased.
 *  2. then the spellings that differ in address data specifically:
 *     Arabic-Indic digits -> 0-9, punctuation -> spaces, "6th of October" ->
 *     "6 october", a leading "El-/Al-" or "ال" dropped, "محافظه ..." /
 *     "... governorate" dropped, whitespace collapsed.
 */

function tidy(normalized) {
  let s = String(normalized || '');
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/[-_.,'’"()/\\،]+/g, ' ');
  s = s.replace(/(\d+)(st|nd|rd|th)\b/g, '$1');
  s = s.replace(/\bof\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^محافظه\s+/, '').replace(/\s+(governorate|gov)$/, '').replace(/^governorate\s+/, '');
  s = s.replace(/^(el|al)\s+/, '');
  s = s.replace(/^ال(?=\S{2,})/, '');
  return s.trim();
}

/** Normalises many strings in one round trip. */
async function normalizeAll(values) {
  if (values.length === 0) return [];
  const rows = await db.sequelize.query(
    `SELECT zimos_normalize_search(t.v) AS n
       FROM unnest($values::text[]) WITH ORDINALITY AS t(v, i)
      ORDER BY t.i`,
    { bind: { values: values.map((v) => (v == null ? '' : String(v))) }, type: QueryTypes.SELECT }
  );
  return rows.map((row) => tidy(row.n));
}

/**
 * A city/district list (listCities) as a two-level tree. The zone a district
 * belongs to is an alias of the district: an order's "New Cairo" matches the
 * district in zone New Cairo.
 */
function citiesToTree(cities) {
  return cities.map((city) => ({
    id: city.id,
    name: city.name,
    nameAr: city.nameAr,
    dropOffAvailable: city.dropOffAvailable,
    meta: {},
    children: (city.districts || []).map((d) => ({
      id: d.id,
      name: d.name,
      nameAr: d.nameAr,
      dropOffAvailable: d.dropOffAvailable,
      aliases: [d.zoneName, d.zoneNameAr],
      meta: { zoneId: d.zoneId, zoneName: d.zoneName, zoneNameAr: d.zoneNameAr },
    })),
  }));
}

/**
 * Pre-computes the normalised names of every node of a carrier's address
 * tree. Built once per cache fill, not per shipment.
 */
async function buildIndex(tree) {
  const strings = [];
  const slot = (value) => {
    strings.push(value || '');
    return strings.length - 1;
  };
  const plan = (nodes, depth) =>
    (nodes || []).map((node) => ({
      node,
      depth,
      names: [slot(node.name), slot(node.nameAr)],
      aliases: (node.aliases || []).map(slot),
      children: plan(node.children, depth + 1),
    }));
  const planned = plan(tree, 0);
  const normalized = await normalizeAll(strings);
  const pick = (slots) => [...new Set(slots.map((i) => normalized[i]).filter(Boolean))];
  const finish = (entries, parent) =>
    entries.map((e) => {
      const entry = { node: e.node, depth: e.depth, parent, names: pick(e.names), aliases: pick(e.aliases) };
      entry.children = finish(e.children, entry);
      return entry;
    });
  return finish(planned, null);
}

/**
 * The storefront sends the governorate bilingually, "القاهرة (Cairo)". Such a
 * value is tried as its two parts; anything else is tried as it is.
 */
function nameVariants(raw) {
  const text = raw == null ? '' : String(raw);
  const parts = text.match(/^\s*([^()]+?)\s*\(\s*([^()]+?)\s*\)\s*$/);
  return parts ? [parts[1], parts[2]] : [text];
}

const deliverable = (entry) => entry.node.dropOffAvailable !== false;

/** Entries any of the normalised names match exactly, each entry once. */
const named = (entries, names) => entries.filter((e) => names.some((name) => name && e.names.includes(name)));

/** Root first. */
function pathOf(entry) {
  const path = [];
  for (let e = entry; e; e = e.parent) path.unshift(e);
  return path;
}

const nodeView = (node) => ({ id: node.id, name: node.name, nameAr: node.nameAr });

/**
 * One level down: an exact name, else an alias (a district's zone), else
 * only suggestions. Returns { match } or { suggestions }.
 */
function matchAmong(entries, text) {
  const exact = entries.filter((e) => e.names.includes(text));
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { suggestions: exact };

  const byAlias = entries.filter((e) => e.aliases.includes(text));
  // A district named like its own zone wins over the zone's other districts.
  const sameName = byAlias.filter((e) => e.names.some((n) => e.aliases.includes(n)));
  if (sameName.length === 1) return { match: sameName[0] };
  if (byAlias.length === 1) return { match: byAlias[0] };
  return {
    suggestions:
      byAlias.length > 0 ? byAlias : entries.filter((e) => e.names.some((n) => n.includes(text) || text.includes(n))),
  };
}

/** Deliverable entries two or more levels below `entry` named (or aliased) exactly `text`. */
function deepMatches(entry, text) {
  const found = [];
  const walk = (entries, depthBelow) => {
    for (const e of entries.filter(deliverable)) {
      if (depthBelow >= 2 && (e.names.includes(text) || e.aliases.includes(text))) found.push(e);
      walk(e.children, depthBelow + 1);
    }
  };
  walk(entry.children, 1);
  return found;
}

// --- results and errors -------------------------------------------------------

function resolvedFrom(entry, levels) {
  const path = pathOf(entry).map((e) => ({ ...nodeView(e.node), level: levels[e.depth], meta: e.node.meta || {} }));
  const result = { path };
  if (isCityDistrict(levels)) {
    Object.assign(result, {
      cityId: path[0].id,
      cityName: path[0].name,
      districtId: path[1].id,
      zoneId: path[1].meta.zoneId || null,
    });
  }
  return result;
}

function cityDistrictCandidate(city, district, suggested) {
  const meta = (district && district.meta) || {};
  return {
    cityId: city.id,
    cityName: city.name,
    cityNameAr: city.nameAr,
    districtId: district ? district.id : null,
    districtName: district ? district.name : null,
    districtNameAr: district ? district.nameAr : null,
    zoneId: district ? meta.zoneId || null : null,
    zoneName: district ? meta.zoneName || null : null,
    suggested,
  };
}

/**
 * 422 CARRIER_ADDRESS_UNMATCHED at `depth`, the candidates being entries of
 * that level. City/district carriers keep their original body exactly;
 * others get the level list, the part already matched and a path per
 * candidate.
 */
function unmatched(adapter, depth, orderAddress, matched, candidates, suggested) {
  const levels = adapter.capabilities.addressLevels;
  const matchedCity = matched ? nodeView(pathOf(matched)[0].node) : null;

  if (isCityDistrict(levels)) {
    const level = depth === 0 ? 'city' : 'district';
    const what = level === 'city' ? 'city/governorate' : 'district/area';
    return new AppError(
      'CARRIER_ADDRESS_UNMATCHED',
      `Could not match the order's ${what} to the carrier's list. Choose it and send carrierAddress.cityId and carrierAddress.districtId.`,
      422,
      {
        carrierCode: adapter.code,
        level,
        orderAddress,
        matchedCity,
        candidates: candidates.map((e) =>
          depth === 0
            ? cityDistrictCandidate(e.node, null, suggested.has(e))
            : cityDistrictCandidate(e.parent.node, e.node, suggested.has(e))
        ),
      }
    );
  }

  return new AppError(
    'CARRIER_ADDRESS_UNMATCHED',
    `Could not match the order's address to the carrier's ${levels[depth]} list. Choose it and send carrierAddress.path, one id per level (${levels.join(' > ')}).`,
    422,
    {
      carrierCode: adapter.code,
      level: levels[depth],
      levelIndex: depth,
      levels,
      orderAddress,
      matchedCity,
      matchedPath: matched ? pathOf(matched).map((e) => nodeView(e.node)) : [],
      candidates: candidates.map((e) => ({
        ...nodeView(e.node),
        path: pathOf(e).map((p) => nodeView(p.node)),
        leaf: e.children.length === 0,
        suggested: suggested.has(e),
      })),
    }
  );
}

const invalid = (field, message) => new AppError('VALIDATION_ERROR', 'Validation failed', 422, [{ field, message }]);

/** Explicit city/district ids. Not checked for drop-off availability. */
function explicitCityDistrict(index, levels, explicit) {
  const city = index.find((e) => e.node.id === explicit.cityId);
  const district = city && city.children.find((e) => e.node.id === explicit.districtId);
  if (!city || !district) {
    throw invalid(
      city ? 'carrierAddress.districtId' : 'carrierAddress.cityId',
      city ? 'Not a district of that city in the carrier\'s list' : 'Not a city in the carrier\'s list'
    );
  }
  return resolvedFrom(district, levels);
}

/** Explicit ids as a path, one per level, top first. */
function explicitPath(index, levels, path) {
  if (path.length !== levels.length) {
    throw invalid('carrierAddress.path', `Needs ${levels.length} ids, one per level (${levels.join(' > ')})`);
  }
  let entries = index;
  let entry = null;
  for (let i = 0; i < path.length; i += 1) {
    entry = entries.find((e) => e.node.id === path[i]);
    if (!entry) {
      throw invalid(
        `carrierAddress.path.${i}`,
        i === 0 ? `Not a ${levels[0]} in the carrier's list` : `Not a ${levels[i]} of that ${levels[i - 1]} in the carrier's list`
      );
    }
    entries = entry.children;
  }
  return resolvedFrom(entry, levels);
}

/**
 * @param {object} adapter          the carrier adapter (code, capabilities)
 * @param {Array}  index            buildIndex() of the carrier's tree
 * @param {object} shippingAddress  the order's address snapshot
 * @param {object} [explicit]       carrierAddress: { cityId, districtId } or { path: [...] }
 * @returns {{ path: [{ id, name, nameAr, level, meta }], cityId?, cityName?, districtId?, zoneId? }}
 * @throws 422 CARRIER_ADDRESS_UNMATCHED, or 422 VALIDATION_ERROR for explicit
 *         ids that aren't in the carrier's list
 */
async function matchAddress(adapter, index, shippingAddress, explicit) {
  const levels = adapter.capabilities.addressLevels;

  if (explicit && Array.isArray(explicit.path)) return explicitPath(index, levels, explicit.path);
  if (explicit && (explicit.cityId || explicit.districtId)) {
    return isCityDistrict(levels)
      ? explicitCityDistrict(index, levels, explicit)
      : explicitPath(index, levels, [explicit.cityId, explicit.districtId].filter(Boolean));
  }

  const address = shippingAddress || {};
  const orderAddress = { province: address.province || null, city: address.city || null };
  const provinceVariants = nameVariants(address.province);
  const areaVariants = nameVariants(address.city);
  const [area, ...rest] = await normalizeAll([address.city || '', ...provinceVariants, ...areaVariants]);
  const provinceNames = rest.slice(0, provinceVariants.length);
  const areaNames = rest.slice(provinceVariants.length);
  const tops = index.filter(deliverable);

  let topMatches = named(tops, provinceNames);
  let areaText = area;
  if (topMatches.length === 0 && area) {
    // No province, or one we can't read: the "city" field may itself be the
    // governorate ("Cairo"). Then there is no area text left to match on.
    topMatches = named(tops, areaNames);
    if (topMatches.length > 0) areaText = '';
  }
  if (topMatches.length !== 1) {
    const several = topMatches.length > 1;
    throw unmatched(adapter, 0, orderAddress, null, several ? topMatches : tops, new Set(several ? topMatches : []));
  }

  let entry = topMatches[0];
  for (;;) {
    if (entry.children.length === 0) return resolvedFrom(entry, levels);
    const children = entry.children.filter(deliverable);

    let suggestions = [];
    if (areaText) {
      const found = matchAmong(children, areaText);
      let next = found.match || null;
      if (!next) {
        // A carrier with more levels than the order has fields: the area may
        // name a node further down (a neighbourhood under a city).
        const deep = deepMatches(entry, areaText);
        if (deep.length === 1) next = deep[0];
      }
      if (next) {
        entry = next;
        areaText = '';
        continue;
      }
      suggestions = found.suggestions;
    }

    const suggested = new Set(suggestions);
    const ordered = [...suggestions, ...children.filter((c) => !suggested.has(c))];
    throw unmatched(adapter, entry.depth + 1, orderAddress, entry, ordered, suggested);
  }
}

module.exports = { buildIndex, citiesToTree, matchAddress, normalizeAll, tidy };
