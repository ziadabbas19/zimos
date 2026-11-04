'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { NotFoundError } = require('../../core/errors/AppError');
const { ancestryOf, descendantsOf } = require('../catalog/collectionTree');
const { loadPublicProducts, wantsCards } = require('./publicProduct');
const { notHiddenSql } = require('../catalog/productPage');

/*
 * The storefront's product listing with search, filters, sort, paging and
 * facet counts — GET /store/:id/products with any of search / collection /
 * tag[] / minPrice / maxPrice / option[...] / sort / page / facets. (Without
 * them the listing keeps its original id-ordered cursor paging, see
 * storefrontService.listProducts, so every existing caller is unchanged.)
 *
 * Search compares through zimos_normalize_search (migration 088): Arabic alef
 * forms, taa marbuta / haa, alef maqsura / yaa, tashkeel and tatweel all fold
 * to one form and Latin is lower-cased, on both sides. LIKE wildcards in the
 * shopper's text are escaped, so "50%_off" matches that text and nothing else.
 *
 * Relevance, best first (the highest single reason wins):
 *   100  the name, exactly
 *    90  a variant's SKU, exactly
 *    85  the name starts with the text
 *    75  a word in the name starts with it
 *    60  the name contains it
 *    55  a tag, exactly            35  a tag contains it
 *    50  every word of it is in the name (words in any order)
 *    45  a SKU contains it
 *    25  every word of it is somewhere: name, tags or description — or close
 *        to a word of the name (a typo)
 *    20  the description contains it
 *  10–40  one word, close to the name (pg_trgm word_similarity ≥ 0.3): what
 *         catches a typo in a single-word search. Only from 3 characters,
 *         where trigrams mean something.
 * Several words must all be found (each allowing a typo) — "blue watch" is
 * not every blue thing and every watch.
 *
 * One pass scores every product the other filters allow and keeps the
 * matches (up to MAX_MATCHES, best first); the page, the facet counts and the
 * related products are then read off those ids instead of searching again.
 * On the first page, "related" adds up to eight products that match nothing
 * but share a collection or a tag with the top matches — or, when nothing
 * matched, the nearest names — never repeating one.
 *
 * STOREFRONT_SEARCH_FAST_ENABLED changes how these are read, never what they
 * answer (tests/integration/storefrontSearchParity.test.js compares the two):
 * only a description that holds the text is folded (found through migration
 * 740's index), a pipeline carries only the columns it needs, and the total is
 * not counted beside the page. Off, the queries are exactly the ones they were.
 */

const TRGM_MIN_CHARS = 3;
const TRGM_THRESHOLD = 0.3;
const TERM_TRGM_THRESHOLD = 0.45;
const MAX_TERMS = 6;
const MAX_MATCHES = 5000;
const RELATED_LIMIT = 8;
const RELATED_FROM_TOP = 5;
const NEAREST_THRESHOLD = 0.12;
const SUGGEST_LIMIT = 8;
const SUGGEST_COLLECTIONS = 3;
const FACET_TAGS_LIMIT = 50;
const FACET_OPTION_VALUES_LIMIT = 500;

const SORT_ORDER = {
  relevance: 'score DESC, sim DESC, created_at DESC, id DESC',
  newest: 'priority DESC, created_at DESC, id DESC',
  price_asc: 'min_price ASC NULLS LAST, created_at DESC, id DESC',
  price_desc: 'min_price DESC NULLS LAST, created_at DESC, id DESC',
  name: 'lower(name) ASC, id ASC',
  position: 'coll_pos ASC NULLS LAST, priority DESC, created_at DESC, id DESC',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapses whitespace and caps the length; the database does the folding. */
function cleanQuery(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** LIKE's wildcards and its escape character, made literal. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Collects bind values under generated $names, so no value is ever spliced into SQL. */
function binder() {
  const bind = {};
  let n = 0;
  return {
    bind,
    add(value, prefix = 'v') {
      const key = `${prefix}${n++}`;
      bind[key] = value;
      return `$${key}`;
    },
  };
}

const select = (sql, bind) => db.sequelize.query(sql, { bind, type: QueryTypes.SELECT });

const fast = () => env.storefrontPerf.searchFast === true;

/**
 * Descriptions are searched on their first DESCRIPTION_CHARS characters: the
 * few words that say what a product is sit at the top, and a 20 000-character
 * description folded on every search would cost more than it finds.
 */
const DESCRIPTION_CHARS = 2000;
/** Byte for byte what migration 740 indexes: an index on an expression that merely means the same is never used. */
const FOLDED_DESCRIPTION = `zimos_normalize_search(left(coalesce(p.description, ''), ${DESCRIPTION_CHARS}))`;

/**
 * The scoring pipeline for `q` over the products `where` admits, as a WITH
 * prefix that defines `scored` (id, name, slug, media, created_at, score,
 * sim). Each stage is MATERIALIZED on purpose: left to itself the planner
 * inlines the folded columns into every place the score reads them, and folds
 * the same name six times per row — measured at 610ms for 5 000 products,
 * against a fraction of that computed once.
 *
 *   sku     one pass over the store's variants whose SKU contains the text
 *   folded  name (the expression migration 119 indexes), description and
 *           tags, folded once per product; `sim` is the name similarity
 *   scored  the score, from the above
 *
 * `lean` (STOREFRONT_SEARCH_FAST_ENABLED): `scored` holds only id, created_at,
 * score and sim. Descriptions are not folded product by product: one small
 * stage per text (`d0` the whole search, `d1`... each word) asks migration 740's
 * index which descriptions hold it, and the score asks those stages. A word of
 * fewer than TRGM_MIN_CHARS characters has no trigrams to ask the index with, so
 * a search with one folds each description once, as it always did.
 */
function scoringPipeline(b, q, workspaceId, where, { description = true, lean = false } = {}) {
  const raw = b.add(q, 'q');
  const escaped = b.add(escapeLike(q), 'qe');
  const folded = `zimos_normalize_search(${raw})`;
  const contains = `('%' || zimos_normalize_search(${escaped}) || '%')`;
  const prefix = `(zimos_normalize_search(${escaped}) || '%')`;
  const wordPrefix = `('% ' || zimos_normalize_search(${escaped}) || '%')`;
  const terms = [...new Set(q.split(' ').filter(Boolean))].slice(0, MAX_TERMS);
  const multi = terms.length > 1;
  const single = !multi && [...q].length >= TRGM_MIN_CHARS;

  // The test "this product's description holds this text", as lean or as it always was.
  const words = [q, ...(multi ? terms : [])];
  const askIndex = lean && description && words.every((word) => [...word].length >= TRGM_MIN_CHARS);
  const descStages = [];
  const inDescription = (pattern) => {
    if (!askIndex) return `f.ndesc LIKE ${pattern} ESCAPE '\\'`;
    const name = `d${descStages.length}`;
    descStages.push({ name, pattern });
    return `f.id IN (SELECT id FROM ${name})`;
  };

  const parts = [
    `CASE WHEN f.nname = ${folded} THEN 100
          WHEN f.nname LIKE ${prefix} ESCAPE '\\' THEN 85
          WHEN f.nname LIKE ${wordPrefix} ESCAPE '\\' THEN 75
          WHEN f.nname LIKE ${contains} ESCAPE '\\' THEN 60
          ELSE 0 END`,
    'coalesce(sku.score, 0)',
    // The tags are only looked at one by one when their folded text holds the query at all.
    `CASE WHEN f.ntags LIKE ${contains} ESCAPE '\\'
          THEN CASE WHEN EXISTS (SELECT 1 FROM unnest(f.tags) AS st(tag) WHERE zimos_normalize_search(st.tag) = ${folded})
                    THEN 55 ELSE 35 END
          ELSE 0 END`,
    description ? `CASE WHEN ${inDescription(contains)} THEN 20 ELSE 0 END` : '0',
  ];
  if (multi) {
    const inName = [];
    const anywhere = [];
    for (const term of terms) {
      const t = `('%' || zimos_normalize_search(${b.add(escapeLike(term), 'te')}) || '%')`;
      const close =
        [...term].length >= TRGM_MIN_CHARS
          ? ` OR word_similarity(zimos_normalize_search(${b.add(term, 'tr')}), f.nname) >= ${TERM_TRGM_THRESHOLD}`
          : '';
      inName.push(`f.nname LIKE ${t} ESCAPE '\\'`);
      anywhere.push(
        `(f.nname LIKE ${t} ESCAPE '\\' OR f.ntags LIKE ${t} ESCAPE '\\'${
          description ? ` OR ${inDescription(t)}` : ''
        }${close})`
      );
    }
    parts.push(`CASE WHEN ${inName.join(' AND ')} THEN 50 WHEN ${anywhere.join(' AND ')} THEN 25 ELSE 0 END`);
  } else if (single) {
    parts.push(`CASE WHEN f.sim >= ${TRGM_THRESHOLD} THEN 10 + 30 * f.sim ELSE 0 END`);
  }

  if (lean) {
    const descs = descStages
      .map(({ name, pattern }) => `${name} AS MATERIALIZED (
      SELECT p.id FROM products p WHERE ${where} AND ${FOLDED_DESCRIPTION} LIKE ${pattern} ESCAPE '\\'
    ),`)
      .join('\n    ');
    return `WITH sku AS MATERIALIZED (
      SELECT sv.product_id, MAX(CASE WHEN lower(sv.sku) = lower(${raw}) THEN 90 ELSE 45 END) AS score
        FROM product_variants sv
       WHERE sv.workspace_id = ${b.add(workspaceId, 'sw')} AND sv.status = 'active'
         AND lower(sv.sku) LIKE ('%' || lower(${escaped}) || '%') ESCAPE '\\'
       GROUP BY sv.product_id
    ),
    ${descs}
    folded AS MATERIALIZED (
      SELECT x.*, ${multi || single ? `word_similarity(${folded}, x.nname)` : '0::real'} AS sim
        FROM (
          SELECT p.id, p.created_at, p.tags,
                 zimos_normalize_search(p.name) AS nname,
                 ${description && !askIndex ? FOLDED_DESCRIPTION : "''"} AS ndesc,
                 zimos_normalize_search(array_to_string(p.tags, ' ')) AS ntags
            FROM products p
           WHERE ${where}
          OFFSET 0
        ) x
    ),
    scored AS MATERIALIZED (
      SELECT f.id, f.created_at, f.sim, GREATEST(${parts.join(',\n')}) AS score
        FROM folded f LEFT JOIN sku ON sku.product_id = f.id
    )`;
  }

  return `WITH sku AS MATERIALIZED (
      SELECT sv.product_id, MAX(CASE WHEN lower(sv.sku) = lower(${raw}) THEN 90 ELSE 45 END) AS score
        FROM product_variants sv
       WHERE sv.workspace_id = ${b.add(workspaceId, 'sw')} AND sv.status = 'active'
         AND lower(sv.sku) LIKE ('%' || lower(${escaped}) || '%') ESCAPE '\\'
       GROUP BY sv.product_id
    ),
    folded AS MATERIALIZED (
      SELECT x.*, ${multi || single ? `word_similarity(${folded}, x.nname)` : '0::real'} AS sim
        FROM (
          SELECT p.id, p.name, p.slug, p.media, p.created_at, p.tags,
                 zimos_normalize_search(p.name) AS nname,
                 ${description ? `zimos_normalize_search(left(coalesce(p.description, ''), ${DESCRIPTION_CHARS}))` : "''"} AS ndesc,
                 zimos_normalize_search(array_to_string(p.tags, ' ')) AS ntags
            FROM products p
           WHERE ${where}
          OFFSET 0
        ) x
    ),
    scored AS MATERIALIZED (
      SELECT f.id, f.name, f.slug, f.media, f.created_at, f.sim, GREATEST(${parts.join(',\n')}) AS score
        FROM folded f LEFT JOIN sku ON sku.product_id = f.id
    )`;
}

/**
 * WHERE conditions for the filters, all scoped to the workspace and to
 * active products. `skip` leaves one group out — how each facet counts what
 * choosing one of its values would show. Search is applied as the list of
 * matched ids (`filters.matchedIds`), set once by matchSearch.
 */
function filterConditions(b, filters, skip = new Set()) {
  const conditions = [`p.workspace_id = ${b.add(filters.workspaceId, 'ws')}`, "p.status = 'active'", notHiddenSql('p')];
  if (filters.matchedIds && !skip.has('search')) {
    conditions.push(`p.id = ANY(${b.add(filters.matchedIds, 'm')}::uuid[])`);
  }
  if (filters.collectionIds && !skip.has('collections')) {
    conditions.push(
      `EXISTS (SELECT 1 FROM product_collections fpc
                WHERE fpc.product_id = p.id AND fpc.collection_id = ANY(${b.add(filters.collectionIds, 'c')}::uuid[]))`
    );
  }
  if (filters.tags && filters.tags.length > 0 && !skip.has('tags')) {
    conditions.push(`p.tags && ${b.add(filters.tags, 't')}::varchar[]`);
  }
  // Price and options must hold on one and the same variant: "a medium, in
  // red, under 300" is one variant, not three.
  const variant = [];
  if (!skip.has('price')) {
    if (filters.minPrice !== undefined) variant.push(`fv.price_amount >= ${b.add(filters.minPrice, 'min')}`);
    if (filters.maxPrice !== undefined) variant.push(`fv.price_amount <= ${b.add(filters.maxPrice, 'max')}`);
  }
  if (!skip.has('options')) {
    for (const [name, values] of Object.entries(filters.options || {})) {
      variant.push(`(fv.option_values ->> ${b.add(name, 'on')}) = ANY(${b.add(values, 'ov')}::text[])`);
    }
  }
  if (variant.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM product_variants fv
                WHERE fv.product_id = p.id AND fv.status = 'active' AND ${variant.join(' AND ')})`
    );
  }
  return conditions;
}

/**
 * Scores every product the other filters allow, once, and keeps the matches:
 * best first, at most MAX_MATCHES. Sets filters.matchedIds and returns the
 * score and similarity per id for the relevance sort.
 */
async function matchSearch(filters) {
  const b = binder();
  const where = filterConditions(b, filters, new Set(['search'])).join(' AND ');
  const rows = await select(
    `${scoringPipeline(b, filters.search, filters.workspaceId, where, { lean: fast() })}
     SELECT id, score, sim FROM scored
      WHERE score > 0
      ORDER BY score DESC, sim DESC
      LIMIT ${MAX_MATCHES}`,
    b.bind
  );
  filters.matchedIds = rows.map((row) => row.id);
  return new Map(rows.map((row) => [row.id, { score: Number(row.score), sim: Number(row.sim) }]));
}

/** Every collection in the store, with lookups for the tree. */
async function loadCollections(workspaceId) {
  const rows = await db.Collection.findAll({
    where: { workspaceId },
    attributes: ['id', 'name', 'slug', 'description', 'seo', 'parentId', 'position', 'imageUrl'],
    order: [
      ['position', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  const all = rows.map((row) => row.toJSON());
  const parentOf = new Map(all.map((c) => [c.id, c.parentId || null]));
  const byId = new Map(all.map((c) => [c.id, c]));
  return { all, parentOf, byId };
}

/**
 * A collection by id or slug, with every collection under it (a parent lists
 * its sub-collections' products too) and the breadcrumb trail down to it.
 */
function resolveCollection(tree, ref) {
  const found = UUID.test(ref) ? tree.byId.get(ref) : tree.all.find((c) => c.slug === ref);
  if (!found) throw new NotFoundError('Collection');
  const ids = [found.id, ...descendantsOf(tree.parentOf, found.id)];
  const breadcrumbs = ancestryOf(tree.parentOf, found.id).map((id) => {
    const c = tree.byId.get(id);
    return { id: c.id, name: c.name, slug: c.slug };
  });
  return { collection: found, collectionIds: ids, breadcrumbs };
}

/** Parses the validated query into the filters above. */
function readFilters(workspaceId, query, tree) {
  const filters = { workspaceId };
  let resolved = null;
  const ref = query.collection || query.collectionId;
  if (ref) {
    resolved = resolveCollection(tree, ref);
    filters.collectionIds = resolved.collectionIds;
  }
  const tags = []
    .concat(query.tag || [])
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (tags.length > 0) filters.tags = [...new Set(tags)];
  if (query.minPrice !== undefined) filters.minPrice = query.minPrice;
  if (query.maxPrice !== undefined) filters.maxPrice = query.maxPrice;
  if (query.options && Object.keys(query.options).length > 0) filters.options = query.options;
  const search = cleanQuery(query.search);
  if (search) filters.search = search;
  return { filters, resolved };
}

async function facetsFor(filters, tree) {
  // Collections: products in each, a parent counting its sub-collections'.
  const cb = binder();
  const links = await select(
    `SELECT pc.collection_id AS "collectionId", p.id AS "productId"
       FROM products p JOIN product_collections pc ON pc.product_id = p.id
      WHERE ${filterConditions(cb, filters, new Set(['collections'])).join(' AND ')}
      LIMIT 20000`,
    cb.bind
  );
  const members = new Map();
  for (const { collectionId, productId } of links) {
    for (const id of ancestryOf(tree.parentOf, collectionId)) {
      if (!members.has(id)) members.set(id, new Set());
      members.get(id).add(productId);
    }
  }
  const collections = tree.all.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    parentId: c.parentId || null,
    count: members.has(c.id) ? members.get(c.id).size : 0,
  }));

  const tb = binder();
  const tags = await select(
    `SELECT tag AS value, COUNT(*)::int AS count
       FROM products p CROSS JOIN LATERAL unnest(p.tags) AS tag
      WHERE ${filterConditions(tb, filters, new Set(['tags'])).join(' AND ')}
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT ${FACET_TAGS_LIMIT}`,
    tb.bind
  );

  // Every option counts as if no option were chosen: close enough for a
  // sidebar, and one query instead of one per option.
  const ob = binder();
  const optionRows = await select(
    `SELECT kv.key AS name, kv.value AS value, COUNT(DISTINCT p.id)::int AS count
       FROM products p
       JOIN product_variants v ON v.product_id = p.id AND v.status = 'active' AND jsonb_typeof(v.option_values) = 'object'
       CROSS JOIN LATERAL jsonb_each_text(v.option_values) AS kv
      WHERE ${filterConditions(ob, filters, new Set(['options'])).join(' AND ')}
      GROUP BY kv.key, kv.value
      ORDER BY kv.key ASC, count DESC, kv.value ASC
      LIMIT ${FACET_OPTION_VALUES_LIMIT}`,
    ob.bind
  );
  const byOption = new Map();
  for (const row of optionRows) {
    if (!byOption.has(row.name)) byOption.set(row.name, []);
    byOption.get(row.name).push({ value: row.value, count: row.count });
  }
  const options = [...byOption.entries()].map(([name, values]) => ({ name, values }));

  const pb = binder();
  const [price] = await select(
    `SELECT MIN(v.price_amount)::bigint AS min, MAX(v.price_amount)::bigint AS max
       FROM products p JOIN product_variants v ON v.product_id = p.id AND v.status = 'active'
      WHERE ${filterConditions(pb, filters, new Set(['price'])).join(' AND ')}`,
    pb.bind
  );

  return {
    collections,
    tags,
    options,
    price: {
      min: price && price.min !== null ? Number(price.min) : null,
      max: price && price.max !== null ? Number(price.max) : null,
    },
  };
}

/** Up to RELATED_LIMIT products that are not matches but sit near the top ones. */
async function relatedFor(filters, topIds) {
  const b = binder();
  const others = { ...filters, matchedIds: undefined };
  const conditions = filterConditions(b, others);
  // Never a product the search already matched.
  if (filters.matchedIds.length > 0) conditions.push(`NOT (p.id = ANY(${b.add(filters.matchedIds, 'x')}::uuid[]))`);

  if (topIds.length > 0) {
    // What the top matches have in common with others: their collections and tags.
    const nb = binder();
    const top = nb.add(topIds, 'top');
    const [shared] = await select(
      `SELECT ARRAY(SELECT DISTINCT pc.collection_id FROM product_collections pc WHERE pc.product_id = ANY(${top}::uuid[])) AS collections,
              ARRAY(SELECT DISTINCT tag FROM products tp CROSS JOIN LATERAL unnest(tp.tags) AS tag
                     WHERE tp.id = ANY(${top}::uuid[]) AND tp.workspace_id = ${nb.add(filters.workspaceId, 'ws')}) AS tags`,
      nb.bind
    );
    const collections = shared ? shared.collections || [] : [];
    const tags = shared ? shared.tags || [] : [];
    if (collections.length === 0 && tags.length === 0) return [];

    const cols = b.add(collections, 'sc');
    const tagList = b.add(tags, 'st');
    // Only products sharing one of them are scored at all (both are indexed).
    conditions.push(
      `(EXISTS (SELECT 1 FROM product_collections rc WHERE rc.product_id = p.id AND rc.collection_id = ANY(${cols}::uuid[]))
        OR p.tags && ${tagList}::varchar[])`
    );
    const rows = await select(
      `SELECT p.id,
              (SELECT COUNT(*) FROM product_collections a WHERE a.product_id = p.id AND a.collection_id = ANY(${cols}::uuid[])) * 2
            + cardinality(ARRAY(SELECT unnest(p.tags) INTERSECT SELECT unnest(${tagList}::varchar[]))) AS affinity
         FROM products p
        WHERE ${conditions.join(' AND ')}
        ORDER BY affinity DESC, p.created_at DESC, p.id DESC
        LIMIT ${RELATED_LIMIT}`,
      b.bind
    );
    return rows.map((row) => row.id);
  }

  // Nothing matched: the nearest names, however loosely.
  if ([...filters.search].length < TRGM_MIN_CHARS) return [];
  const folded = `zimos_normalize_search(${b.add(filters.search, 'q')})`;
  const rows = await select(
    `SELECT id FROM (
        SELECT p.id, p.created_at, word_similarity(${folded}, zimos_normalize_search(p.name)) AS sim
          FROM products p
         WHERE ${conditions.join(' AND ')}
      ) near
      WHERE sim >= ${NEAREST_THRESHOLD}
      ORDER BY sim DESC, created_at DESC
      LIMIT ${RELATED_LIMIT}`,
    b.bind
  );
  return rows.map((row) => row.id);
}

/**
 * One page of the filtered, sorted listing. `query` is the validated query
 * string; the result keeps the legacy `products` / `nextCursor` keys, so a
 * client that only reads those still works.
 */
async function searchProducts(workspaceId, query) {
  const tree = await loadCollections(workspaceId);
  const { filters, resolved } = readFilters(workspaceId, query, tree);
  const limit = query.limit || 24;
  const page = query.page || 1;
  const sort = query.sort || (filters.search ? 'relevance' : 'newest');
  const byRelevance = sort === 'relevance' && Boolean(filters.search);

  const scores = filters.search ? await matchSearch(filters) : null;

  const b = binder();
  const conditions = filterConditions(b, filters);
  const relevanceJoin = byRelevance
    ? `JOIN unnest(${b.add(filters.matchedIds, 'mi')}::uuid[], ${b.add(
        filters.matchedIds.map((id) => scores.get(id).score),
        'ms'
      )}::float8[], ${b.add(
        filters.matchedIds.map((id) => scores.get(id).sim),
        'mm'
      )}::float8[]) AS m(id, score, sim) ON m.id = p.id`
    : '';
  const needsPrice = sort === 'price_asc' || sort === 'price_desc';
  const positionIn =
    resolved && sort === 'position'
      ? `(SELECT MIN(pp.position) FROM product_collections pp
           WHERE pp.product_id = p.id AND pp.collection_id = ${b.add(resolved.collection.id, 'pc')})`
      : 'NULL::int';
  const order = SORT_ORDER[byRelevance ? 'relevance' : sort === 'relevance' ? 'newest' : sort] || SORT_ORDER.newest;

  // Fast: the window count below reads every row the filters allow before LIMIT
  // can stop it, so without it the newest-first page comes straight off an index.
  const lean = fast();
  const page$ = select(
    `SELECT ${lean ? 'id' : 'id, total'} FROM (
        SELECT p.id, p.name, p.created_at, p.priority,
               ${byRelevance ? 'm.score' : '0'} AS score,
               ${byRelevance ? 'm.sim' : '0'} AS sim,
               ${
                 needsPrice
                   ? "(SELECT MIN(mv.price_amount) FROM product_variants mv WHERE mv.product_id = p.id AND mv.status = 'active')"
                   : 'NULL::bigint'
               } AS min_price,
               ${positionIn} AS coll_pos${lean ? '' : `,
               COUNT(*) OVER () AS total`}
          FROM products p ${relevanceJoin}
         WHERE ${conditions.join(' AND ')}
      ) listed
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    b.bind
  );

  let rows;
  let total;
  if (!lean) {
    rows = await page$;
    total = rows.length > 0 ? Number(rows[0].total) : filters.search ? 0 : await countOnly(filters);
  } else if (filters.search) {
    // The matches were scored under these same filters, so they are the count.
    rows = await page$;
    total = rows.length > 0 ? filters.matchedIds.length : 0;
  } else {
    [rows, total] = await Promise.all([page$, countOnly(filters)]);
  }
  const card = wantsCards(query);
  const products = await loadPublicProducts(
    workspaceId,
    rows.map((row) => row.id),
    { card }
  );

  const result = {
    products,
    nextCursor: null,
    page,
    pageSize: limit,
    total,
    hasMore: page * limit < total,
    sort,
  };
  if (resolved) {
    const c = resolved.collection;
    result.collection = {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      seo: c.seo,
      parentId: c.parentId || null,
      imageUrl: c.imageUrl || null,
    };
    result.breadcrumbs = resolved.breadcrumbs;
  }
  if (filters.search) {
    result.matches = products;
    // The top of the list by relevance, whatever order this page is in.
    const topIds = filters.matchedIds.slice(0, RELATED_FROM_TOP);
    const relatedIds = page === 1 ? await relatedFor(filters, topIds) : [];
    result.related = await loadPublicProducts(workspaceId, relatedIds, { card });
  }
  if (query.facets) result.facets = await facetsFor(filters, tree);
  return result;
}

/** A page past the end still reports the total. */
async function countOnly(filters) {
  const b = binder();
  const [row] = await select(`SELECT COUNT(*)::int AS n FROM products p WHERE ${filterConditions(b, filters).join(' AND ')}`, b.bind);
  return row ? row.n : 0;
}

/**
 * The search box's suggestions while the shopper types: at most
 * SUGGEST_LIMIT entries, up to SUGGEST_COLLECTIONS of them collections, the
 * rest products — each with just enough to draw a row.
 */
async function suggest(workspaceId, rawQuery) {
  const q = cleanQuery(rawQuery);
  if (!q) return { query: q, products: [], collections: [] };

  const cb = binder();
  const ws = cb.add(workspaceId, 'ws');
  const escaped = cb.add(escapeLike(q), 'qe');
  const collections = await select(
    `SELECT c.id, c.name, c.slug, c.image_url AS "imageUrl"
       FROM collections c
      WHERE c.workspace_id = ${ws}
        AND zimos_normalize_search(c.name) LIKE ('%' || zimos_normalize_search(${escaped}) || '%') ESCAPE '\\'
      ORDER BY (zimos_normalize_search(c.name) LIKE (zimos_normalize_search(${escaped}) || '%') ESCAPE '\\') DESC,
               c.position ASC, c.name ASC
      LIMIT ${SUGGEST_COLLECTIONS}`,
    cb.bind
  );

  const b = binder();
  const where = `p.workspace_id = ${b.add(workspaceId, 'ws')} AND p.status = 'active' AND ${notHiddenSql('p')}`;
  const limit = SUGGEST_LIMIT - collections.length;
  const rows = await select(
    fast()
      ? `${scoringPipeline(b, q, workspaceId, where, { description: false, lean: true })},
     best AS (
       SELECT id, score, sim, created_at FROM scored
        WHERE score > 0
        ORDER BY score DESC, sim DESC, created_at DESC
        LIMIT ${limit}
     )
     SELECT p.id, p.name, p.slug, p.media, best.score FROM best JOIN products p ON p.id = best.id
      ORDER BY best.score DESC, best.sim DESC, best.created_at DESC`
      : `${scoringPipeline(b, q, workspaceId, where, { description: false })}
     SELECT id, name, slug, media, score FROM scored
      WHERE score > 0
      ORDER BY score DESC, sim DESC, created_at DESC
      LIMIT ${limit}`,
    b.bind
  );

  // The cheapest active variant of each, for the price on the row.
  const prices = new Map();
  if (rows.length > 0) {
    const pb = binder();
    const priced = await select(
      `SELECT DISTINCT ON (v.product_id) v.product_id AS id, v.price_amount AS "priceAmount", v.currency
         FROM product_variants v
        WHERE v.product_id = ANY(${pb.add(
          rows.map((r) => r.id),
          'ids'
        )}::uuid[]) AND v.status = 'active'
        ORDER BY v.product_id, v.price_amount ASC`,
      pb.bind
    );
    for (const p of priced) prices.set(p.id, p);
  }

  return {
    query: q,
    collections,
    products: rows.map((row) => {
      const first = Array.isArray(row.media) ? row.media.find((m) => m && typeof m.url === 'string') : null;
      const price = prices.get(row.id);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        imageUrl: first ? first.url : null,
        priceAmount: price ? String(price.priceAmount) : null,
        currency: price ? price.currency : null,
      };
    }),
  };
}

module.exports = { searchProducts, suggest, escapeLike, cleanQuery };
