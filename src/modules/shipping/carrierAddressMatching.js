'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/**
 * Maps an order's free-text address (province + city, as the storefront
 * collected it) onto a carrier's city/district ids.
 *
 * In Egyptian order data `province` is the governorate — what Bosta calls the
 * city (Cairo, Giza, Alexandria) — and `city` is the area — Bosta's district
 * (Nasr City, Maadi, 15 May). A shipment needs both.
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
 * Pre-computes the normalised names of a carrier's city list (see the
 * adapter's listCities shape). Built once per cache fill, not per shipment.
 */
async function buildIndex(cities) {
  const strings = [];
  const slot = (value) => {
    strings.push(value || '');
    return strings.length - 1;
  };
  const plan = cities.map((city) => ({
    city,
    names: [slot(city.name), slot(city.nameAr)],
    districts: (city.districts || []).map((district) => ({
      district,
      names: [slot(district.name), slot(district.nameAr)],
      zoneNames: [slot(district.zoneName), slot(district.zoneNameAr)],
    })),
  }));
  const normalized = await normalizeAll(strings);
  const pick = (slots) => [...new Set(slots.map((i) => normalized[i]).filter(Boolean))];
  return plan.map((entry) => ({
    city: entry.city,
    names: pick(entry.names),
    districts: entry.districts.map((d) => ({ district: d.district, names: pick(d.names), zoneNames: pick(d.zoneNames) })),
  }));
}

const cityView = (city) => ({ id: city.id, name: city.name, nameAr: city.nameAr });

function candidateRow(city, district, suggested = false) {
  return {
    cityId: city.id,
    cityName: city.name,
    cityNameAr: city.nameAr,
    districtId: district ? district.id : null,
    districtName: district ? district.name : null,
    districtNameAr: district ? district.nameAr : null,
    zoneId: district ? district.zoneId : null,
    zoneName: district ? district.zoneName : null,
    suggested,
  };
}

function unmatched(carrierCode, level, orderAddress, matchedCity, candidates) {
  const what = level === 'city' ? 'city/governorate' : 'district/area';
  return new AppError(
    'CARRIER_ADDRESS_UNMATCHED',
    `Could not match the order's ${what} to the carrier's list. Choose it and send carrierAddress.cityId and carrierAddress.districtId.`,
    422,
    {
      carrierCode,
      level,
      orderAddress,
      matchedCity: matchedCity ? cityView(matchedCity) : null,
      candidates,
    }
  );
}

const deliverable = (entry) => entry.city.dropOffAvailable !== false;
const deliverableDistrict = (d) => d.district.dropOffAvailable !== false;

/**
 * @returns {{ cityId, cityName, districtId, zoneId }}
 * @throws 422 CARRIER_ADDRESS_UNMATCHED, or 422 VALIDATION_ERROR for explicit
 *         ids that aren't in the carrier's list
 */
async function matchAddress(carrierCode, index, shippingAddress, explicit) {
  const address = shippingAddress || {};

  if (explicit && (explicit.cityId || explicit.districtId)) {
    const entry = index.find((e) => e.city.id === explicit.cityId);
    const district = entry && entry.districts.find((d) => d.district.id === explicit.districtId);
    if (!entry || !district) {
      throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
        {
          field: entry ? 'carrierAddress.districtId' : 'carrierAddress.cityId',
          message: entry ? 'Not a district of that city in the carrier\'s list' : 'Not a city in the carrier\'s list',
        },
      ]);
    }
    return {
      cityId: entry.city.id,
      cityName: entry.city.name,
      districtId: district.district.id,
      zoneId: district.district.zoneId || null,
    };
  }

  const orderAddress = { province: address.province || null, city: address.city || null };
  const [province, area] = await normalizeAll([address.province || '', address.city || '']);
  const cities = index.filter(deliverable);

  let cityMatches = province ? cities.filter((e) => e.names.includes(province)) : [];
  let areaText = area;
  if (cityMatches.length === 0 && area) {
    // No province, or one we can't read: the "city" field may itself be the
    // governorate ("Cairo"). Then there is no area text left to match on.
    cityMatches = cities.filter((e) => e.names.includes(area));
    if (cityMatches.length > 0) areaText = '';
  }
  if (cityMatches.length !== 1) {
    throw unmatched(
      carrierCode,
      'city',
      orderAddress,
      null,
      (cityMatches.length > 1 ? cityMatches : cities).map((e) => candidateRow(e.city, null, cityMatches.length > 1))
    );
  }

  const entry = cityMatches[0];
  const districts = entry.districts.filter(deliverableDistrict);
  let suggestions = [];
  if (areaText) {
    const exact = districts.filter((d) => d.names.includes(areaText));
    if (exact.length === 1) return resolved(entry, exact[0]);
    suggestions = exact;

    if (exact.length === 0) {
      // The area may be a zone name ("New Cairo") rather than a district.
      const inZone = districts.filter((d) => d.zoneNames.includes(areaText));
      const sameName = inZone.filter((d) => d.names.some((n) => d.zoneNames.includes(n)));
      if (sameName.length === 1) return resolved(entry, sameName[0]);
      if (inZone.length === 1) return resolved(entry, inZone[0]);
      suggestions = inZone.length > 0
        ? inZone
        : districts.filter((d) => d.names.some((n) => n.includes(areaText) || areaText.includes(n)));
    }
  }

  const suggestedIds = new Set(suggestions.map((d) => d.district.id));
  const ordered = [
    ...suggestions,
    ...districts.filter((d) => !suggestedIds.has(d.district.id)),
  ];
  throw unmatched(
    carrierCode,
    'district',
    orderAddress,
    entry.city,
    ordered.map((d) => candidateRow(entry.city, d.district, suggestedIds.has(d.district.id)))
  );
}

function resolved(entry, district) {
  return {
    cityId: entry.city.id,
    cityName: entry.city.name,
    districtId: district.district.id,
    zoneId: district.district.zoneId || null,
  };
}

module.exports = { buildIndex, matchAddress, normalizeAll, tidy };
