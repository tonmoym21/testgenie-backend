// API Source orchestration.
//
// Public surface:
//   previewImport(raw, opts)         — detect + parse without persisting (paste-box live preview)
//   ingestSource(user, payload)      — detect + fetch (if URL) + parse + persist source/version/endpoints
//   listSources(user)
//   listEndpoints(user, sourceId, q) — filterable
//   commitToCollection(user, args)   — selected endpoint ids → collection_tests rows
//   refreshSource(user, sourceId)    — re-fetch + diff + new version
//
// Everything below this layer (adapters, fetcher, scanner) is wire-format
// agnostic; we only know about NormalizedSource IR.

const db = require('../db');
const logger = require('../utils/logger');
const { detectFromText } = require('./apiSources/detector');
const { fetchSpec } = require('./apiSources/fetcher');
const { adapterFor } = require('./apiSources/adapters');
const { endpointFingerprint, contentAddress } = require('./apiSources/fingerprint');

const PARSER_VERSION = '1.0.0';

// ── Helpers ─────────────────────────────────────────────────────────────

function userScope(user) { return [user.id, user.orgId || null]; }

async function detectAndParse({ raw, urlHint }) {
  // If `urlHint` is set we already pulled the text via the SSRF-safe fetcher,
  // so we just route by content signature. If raw looks like a bare URL,
  // delegate to the url_probe adapter which will do its own fetch.
  const detected = detectFromText(raw);
  if (!detected) {
    const err = new Error('Could not recognise input format');
    err.code = 'UNRECOGNISED_FORMAT';
    throw err;
  }
  if (detected.format === 'json_unknown') {
    // Include the top-level keys + first 200 chars of the body so we (and
    // the user) can see what was actually parsed. Without this, every
    // "wrong response from upstream" case looks identical.
    const keys = detected.doc && typeof detected.doc === 'object' ? Object.keys(detected.doc).slice(0, 10).join(', ') : '(no keys)';
    const sample = typeof raw === 'string' ? raw.slice(0, 200) : '';
    const err = new Error(
      `JSON parsed but no API spec markers found. Top-level keys: [${keys}]. ` +
      `First 200 chars: ${JSON.stringify(sample)}`
    );
    err.code = 'UNKNOWN_JSON_FORMAT';
    throw err;
  }
  const adapter = adapterFor(detected.format);
  if (!adapter) {
    const err = new Error(`No adapter for format ${detected.format}`);
    err.code = 'NO_ADAPTER';
    throw err;
  }
  const ir = await adapter.parse({ format: detected.format, raw, doc: detected.doc });
  return { detected, ir };
}

// ── Public API ──────────────────────────────────────────────────────────

// previewImport: best-effort parse without writing anything. Used by the
// frontend paste box to show endpoint counts before commit.
async function previewImport({ raw, url }) {
  let text = raw;
  let fetchedFrom;
  if (!text && url) {
    const res = await fetchSpec(url);
    text = res.body.toString('utf8');
    fetchedFrom = res.finalUrl;
  }
  if (!text) throw new Error('previewImport: need either raw text or url');

  const { detected, ir } = await detectAndParse({ raw: text });
  return {
    detected: { format: detected.format, hint: detected.hint, confidence: detected.confidence },
    name: ir.name,
    endpointCount: ir.endpoints.length,
    servers: ir.servers,
    authSchemes: ir.authSchemes,
    sourceUrl: fetchedFrom || ir.sourceUrl,
    provenance: ir.__provenance || {},
    // Truncated preview — frontend renders first N to confirm correctness.
    endpointsPreview: ir.endpoints.slice(0, 25).map((e) => ({
      method: e.method, path: e.path, summary: e.summary, tags: e.tags,
    })),
  };
}

// ingestSource: full path. Detect → fetch (if URL) → parse → persist.
async function ingestSource(user, payload) {
  const { name: nameOverride } = payload;
  let raw = payload.raw;
  let sourceUrl = payload.url || null;

  if (!raw && sourceUrl) {
    const res = await fetchSpec(sourceUrl);
    raw = res.body.toString('utf8');
  }
  if (!raw) {
    const err = new Error('ingestSource: need raw text or url');
    err.statusCode = 400;
    throw err;
  }

  const { detected, ir } = await detectAndParse({ raw });
  const sha = contentAddress(raw);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const sourceInsert = await client.query(
      `INSERT INTO api_sources
         (user_id, organization_id, name, protocol, format, spec_version,
          source_url, servers, auth_schemes, refresh_policy, lifecycle_state,
          provenance, endpoint_count, last_fetched_at, parsed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,'active',$11::jsonb,$12,NOW(),NOW())
       RETURNING id`,
      [
        user.id,
        user.orgId || null,
        nameOverride || ir.name,
        ir.protocol,
        ir.format || detected.format,
        ir.specVersion || null,
        sourceUrl || ir.sourceUrl || null,
        JSON.stringify(ir.servers || []),
        JSON.stringify(ir.authSchemes || []),
        JSON.stringify(payload.refreshPolicy || { mode: 'manual' }),
        JSON.stringify({ ...(ir.__provenance || {}), importedAt: new Date().toISOString() }),
        ir.endpoints.length,
      ]
    );
    const sourceId = sourceInsert.rows[0].id;

    const versionInsert = await client.query(
      `INSERT INTO api_source_versions
         (source_id, content_address, raw_size_bytes, parser_version, endpoint_count, change_summary)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING id`,
      [
        sourceId,
        sha,
        Buffer.byteLength(raw, 'utf8'),
        PARSER_VERSION,
        ir.endpoints.length,
        JSON.stringify({ added: ir.endpoints.length, removed: 0, modified: 0 }),
      ]
    );
    const versionId = versionInsert.rows[0].id;

    await client.query(
      `UPDATE api_sources SET current_version_id = $1 WHERE id = $2`,
      [versionId, sourceId]
    );

    const primaryServer = (ir.servers[0] && ir.servers[0].url) || sourceUrl || '';
    for (const ep of ir.endpoints) {
      const fp = endpointFingerprint({ method: ep.method, path: ep.path, server: primaryServer });
      await client.query(
        `INSERT INTO api_endpoints
           (source_id, organization_id, protocol, operation_id, fingerprint,
            method, path, summary, description, tags, auth_requirement,
            request_schema, response_schema, sample_request, bindings,
            examples, vendor_extensions, stability,
            first_seen_version_id, last_seen_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
                 $13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20)`,
        [
          sourceId,
          user.orgId || null,
          ep.protocol,
          ep.operationId || null,
          fp,
          ep.method,
          ep.path,
          ep.summary || null,
          ep.description || null,
          JSON.stringify(ep.tags || []),
          JSON.stringify(ep.authRequirement || []),
          JSON.stringify(ep.requestSchema || {}),
          JSON.stringify(ep.responseSchema || {}),
          JSON.stringify(ep.sampleRequest || {}),
          JSON.stringify(ep.bindings || {}),
          JSON.stringify(ep.examples || []),
          JSON.stringify(ep.vendorExtensions || {}),
          ep.deprecated ? 'deprecated' : 'stable',
          versionId,
          versionId,
        ]
      );
    }

    await client.query('COMMIT');

    logger.info(
      { userId: user.id, sourceId, format: ir.format, endpointCount: ir.endpoints.length },
      'apiSource ingest complete'
    );

    return getSource(user, sourceId, client);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getSource(_user, sourceId, client = db) {
  const r = await client.query(
    `SELECT s.id, s.name, s.protocol, s.format, s.spec_version AS "specVersion",
            s.source_url AS "sourceUrl", s.servers, s.auth_schemes AS "authSchemes",
            s.refresh_policy AS "refreshPolicy", s.lifecycle_state AS "lifecycleState",
            s.provenance, s.endpoint_count AS "endpointCount",
            s.last_fetched_at AS "lastFetchedAt", s.parsed_at AS "parsedAt",
            s.current_version_id AS "currentVersionId", s.created_at AS "createdAt"
       FROM api_sources s
       WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [sourceId]
  );
  return r.rows[0] || null;
}

async function listSources(user) {
  const r = await db.query(
    `SELECT id, name, protocol, format, source_url AS "sourceUrl",
            endpoint_count AS "endpointCount", lifecycle_state AS "lifecycleState",
            last_fetched_at AS "lastFetchedAt", created_at AS "createdAt"
       FROM api_sources
       WHERE deleted_at IS NULL AND ($1::int IS NOT NULL OR $2::int IS NULL)
       ORDER BY created_at DESC`,
    userScope(user)
  );
  return r.rows;
}

async function listEndpoints(_user, sourceId, q = {}) {
  const params = [sourceId];
  let where = `source_id = $1 AND removed_at IS NULL`;

  if (q.method) {
    params.push(q.method.toUpperCase());
    where += ` AND method = $${params.length}`;
  }
  if (q.tag) {
    params.push(q.tag);
    where += ` AND tags::jsonb ? $${params.length}`;
  }
  if (q.search) {
    params.push(`%${q.search.toLowerCase()}%`);
    where += ` AND (LOWER(path) LIKE $${params.length} OR LOWER(coalesce(summary,'')) LIKE $${params.length} OR LOWER(coalesce(operation_id,'')) LIKE $${params.length})`;
  }

  const r = await db.query(
    `SELECT id, method, path, summary, description, tags, fingerprint,
            operation_id AS "operationId", stability, deprecated_at AS "deprecatedAt"
       FROM api_endpoints
       WHERE ${where}
       ORDER BY path, method`,
    params
  );
  return r.rows;
}

async function getEndpoints(_user, endpointIds) {
  if (!Array.isArray(endpointIds) || endpointIds.length === 0) return [];
  const r = await db.query(
    `SELECT id, source_id AS "sourceId", method, path, summary, sample_request AS "sampleRequest",
            operation_id AS "operationId", tags
       FROM api_endpoints
       WHERE id = ANY($1::int[]) AND removed_at IS NULL`,
    [endpointIds]
  );
  return r.rows;
}

// Build a TestForge `test_definition` from a stored endpoint. The shape
// matches what apiRunner consumes: { method, url, headers, body,
// assertions, timeout, extractors, auth }.
function testDefinitionFromEndpoint(ep) {
  const s = ep.sampleRequest || {};
  return {
    method: s.method || ep.method,
    url: s.url || '',
    headers: s.headers || {},
    body: s.body,
    assertions: Array.isArray(s.assertions) && s.assertions.length
      ? s.assertions
      : [{ type: 'status', operator: 'lt', value: 400 }],
    extractors: Array.isArray(s.extractors) ? s.extractors : [],
    timeout: s.timeout || 10000,
  };
}

// commitToCollection: takes selected endpoint ids and creates collection_tests
// rows. Reuses the existing executor — no new execution path.
async function commitToCollection(user, { collectionId, endpointIds, authProfile }) {
  if (!collectionId || !Array.isArray(endpointIds) || endpointIds.length === 0) {
    const err = new Error('collectionId and non-empty endpointIds required');
    err.statusCode = 400;
    throw err;
  }

  const endpoints = await getEndpoints(user, endpointIds);
  if (endpoints.length === 0) {
    const err = new Error('No matching endpoints found');
    err.statusCode = 404;
    throw err;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Confirm collection is reachable (matches collections.js accessClause).
    const colCheck = await client.query(
      `SELECT id FROM collections WHERE id = $1 AND ($2::int IS NOT NULL OR $3::int IS NULL)`,
      [collectionId, user.id, user.orgId || null]
    );
    if (colCheck.rows.length === 0) {
      const err = new Error('Collection not found');
      err.statusCode = 404;
      throw err;
    }

    const created = [];
    for (const ep of endpoints) {
      const def = testDefinitionFromEndpoint(ep);
      // Apply a bulk auth template if supplied. Keeps the import-and-go UX
      // working: user picks 30 endpoints, says "Bearer from {{authToken}}",
      // every generated test gets the header pre-wired.
      if (authProfile && authProfile.type === 'bearer' && authProfile.tokenVar) {
        def.headers = { ...(def.headers || {}), Authorization: `Bearer {{${authProfile.tokenVar}}}` };
      } else if (authProfile && authProfile.type === 'apiKey' && authProfile.headerName && authProfile.tokenVar) {
        def.headers = { ...(def.headers || {}), [authProfile.headerName]: `{{${authProfile.tokenVar}}}` };
      }

      const name = ep.summary || `${ep.method} ${ep.path}`;
      const inserted = await client.query(
        `INSERT INTO collection_tests (collection_id, name, test_type, test_definition, sort_order)
         VALUES ($1, $2, 'api', $3::jsonb, 0)
         RETURNING id, name, test_type AS "testType"`,
        [collectionId, name.slice(0, 200), JSON.stringify(def)]
      );
      created.push({ ...inserted.rows[0], endpointId: ep.id });
    }

    await client.query('COMMIT');
    logger.info(
      { userId: user.id, collectionId, created: created.length },
      'apiSource commit to collection'
    );
    return { created, collectionId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function refreshSource(user, sourceId) {
  // Minimal v1: re-fetch the source URL, parse, persist a new version, and
  // compute (added/removed/modified) counts by fingerprint comparison. The
  // UI's "Drift Inbox" is deferred — this just keeps the version history
  // and counts honest so the inbox has data to render when it ships.
  const source = await getSource(user, sourceId);
  if (!source) {
    const err = new Error('Source not found'); err.statusCode = 404; throw err;
  }
  if (!source.sourceUrl) {
    const err = new Error('Source has no URL; cannot refresh'); err.statusCode = 400; throw err;
  }

  const res = await fetchSpec(source.sourceUrl);
  const raw = res.body.toString('utf8');
  const sha = contentAddress(raw);

  // No-op if content hash is unchanged.
  const existing = await db.query(
    `SELECT id FROM api_source_versions WHERE source_id = $1 AND content_address = $2 ORDER BY id DESC LIMIT 1`,
    [sourceId, sha]
  );
  if (existing.rows.length) {
    return { changed: false, currentVersionId: existing.rows[0].id };
  }

  const { ir } = await detectAndParse({ raw });

  const oldFps = await db.query(
    `SELECT fingerprint FROM api_endpoints WHERE source_id = $1 AND removed_at IS NULL`,
    [sourceId]
  );
  const oldSet = new Set(oldFps.rows.map((r) => r.fingerprint));
  const primaryServer = (ir.servers[0] && ir.servers[0].url) || source.sourceUrl || '';
  const newFps = new Set(ir.endpoints.map((e) =>
    endpointFingerprint({ method: e.method, path: e.path, server: primaryServer })
  ));

  const added = [...newFps].filter((fp) => !oldSet.has(fp)).length;
  const removed = [...oldSet].filter((fp) => !newFps.has(fp)).length;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const v = await client.query(
      `INSERT INTO api_source_versions
         (source_id, content_address, raw_size_bytes, parser_version, endpoint_count, change_summary)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [sourceId, sha, Buffer.byteLength(raw, 'utf8'), PARSER_VERSION, ir.endpoints.length,
       JSON.stringify({ added, removed, modified: 0 })]
    );
    await client.query(
      `UPDATE api_sources SET current_version_id = $1, last_fetched_at = NOW(), parsed_at = NOW(), endpoint_count = $2 WHERE id = $3`,
      [v.rows[0].id, ir.endpoints.length, sourceId]
    );
    await client.query('COMMIT');
    return { changed: true, versionId: v.rows[0].id, summary: { added, removed, modified: 0 } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteSource(user, sourceId) {
  await db.query(
    `UPDATE api_sources SET deleted_at = NOW() WHERE id = $1 AND ($2::int IS NOT NULL OR $3::int IS NULL)`,
    [sourceId, user.id, user.orgId || null]
  );
}

module.exports = {
  previewImport,
  ingestSource,
  listSources,
  getSource,
  listEndpoints,
  commitToCollection,
  refreshSource,
  deleteSource,
  // exported for tests
  testDefinitionFromEndpoint,
};
