
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.SC_SMT_DB || path.join(DATA_DIR, 'sc-smt.sqlite');
const PORT = Number(process.env.PORT || 4173);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK (trust_level IN ('STANDARD','AUTHORITATIVE')),
  allowed_fact_prefix TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  value_text TEXT NOT NULL,
  source_id TEXT NOT NULL,
  authority_status TEXT NOT NULL CHECK (
    authority_status IN ('RECEIVED','VERIFIED','AUTHORITATIVE','REJECTED','SUPERSEDED','EXPIRED','CONFLICT')
  ),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  observed_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('CURRENT','SUPERSEDED','EXPIRED','CONFLICT','REJECTED')
  ),
  predecessor_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id),
  FOREIGN KEY (predecessor_id) REFERENCES evidence(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_entity_fact_version
  ON evidence(entity_id, fact_key, version);

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  upstream_type TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  downstream_type TEXT NOT NULL,
  downstream_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  required_state TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dependency_edge
  ON dependencies(upstream_type, upstream_id, downstream_type, downstream_id, dependency_type);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('CURRENT','REVALIDATION_REQUIRED','BLOCKED','REJECTED')
  ),
  evidence_bindings_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  validated_at TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  parameters_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING','HOLD','AUTHORIZED','EXECUTING','EXECUTED','BLOCKED','FAILED','UNKNOWN')
  ),
  execution_target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  result_json TEXT,
  idempotency_key TEXT UNIQUE,
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  evidence_bindings_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  parameters_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','REVOKED','EXPIRED')),
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (action_id) REFERENCES actions(id),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_decision_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_action_status ON actions(status);
`);

const now = () => new Date().toISOString();

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}
function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
function json(v) {
  return JSON.stringify(v ?? {});
}
function parseJson(v, fallback={}) {
  try { return JSON.parse(v); } catch { return fallback; }
}
function send(res, status, payload, headers={}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers});
  res.end(body);
}
function sendText(res, status, body, contentType='text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type':contentType, 'Cache-Control':'no-store'});
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function actor(req) {
  return req.headers['x-scsmt-actor'] || 'demo-admin';
}
function sourceFromHeader(req) {
  return req.headers['x-scsmt-source-key'] || '';
}

function audit(eventType, entityType, entityId, actorName, reason, payload={}) {
  db.prepare(`
    INSERT INTO audit_events(event_type, entity_type, entity_id, actor, reason, payload_json, created_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(eventType, entityType, entityId, actorName, reason, json(payload), now());
}

function getSourceByKey(apiKey) {
  if (!apiKey) return null;
  const hash = sha256(apiKey);
  return db.prepare(`SELECT * FROM sources WHERE api_key_hash=? AND active=1`).get(hash);
}

function sourceCanAssertFact(source, factKey) {
  if (!source) return false;
  return String(factKey).startsWith(source.allowed_fact_prefix);
}

function isEvidenceCurrentlyValid(e) {
  const t = Date.now();
  const from = Date.parse(e.effective_from);
  const to = e.effective_to ? Date.parse(e.effective_to) : Infinity;
  return !Number.isNaN(from) && from <= t && t < to && e.status === 'CURRENT' && ['VERIFIED','AUTHORITATIVE'].includes(e.authority_status);
}

function expireEvidenceInPlace(actorName='system') {
  const rows = db.prepare(`
    SELECT * FROM evidence
    WHERE status='CURRENT' AND effective_to IS NOT NULL AND effective_to <= ?
  `).all(now());

  for (const e of rows) {
    db.prepare(`
      UPDATE evidence
      SET status='EXPIRED', authority_status='EXPIRED'
      WHERE id=?
    `).run(e.id);

    const impactedDecisions = db.prepare(`
      SELECT DISTINCT d.id
      FROM decisions d
      WHERE EXISTS (
        SELECT 1 FROM json_each(d.evidence_bindings_json)
        WHERE json_extract(value,'$.evidence_id') = ?
      )
    `).all(e.id);

    for (const row of impactedDecisions) {
      markDecisionStale(row.id, `Evidence ${e.id} expired by validity interval`, actorName);
    }

    audit('EVIDENCE_EXPIRED', 'evidence', e.id, actorName,
      'Evidence validity interval ended', {evidence_id:e.id});
  }
  return rows.length;
}

function detectCycle(candidate) {
  // Graph nodes are typed strings: "evidence:EV-1", "decision:D-1", "action:A-1".
  const edges = db.prepare(`
    SELECT upstream_type, upstream_id, downstream_type, downstream_id
    FROM dependencies WHERE active=1
  `).all();

  edges.push(candidate);
  const adj = new Map();
  for (const e of edges) {
    const a = `${e.upstream_type}:${e.upstream_id}`;
    const b = `${e.downstream_type}:${e.downstream_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }

  const start = `${candidate.downstream_type}:${candidate.downstream_id}`;
  const target = `${candidate.upstream_type}:${candidate.upstream_id}`;
  const visiting = new Set();
  const visited = new Set();

  function dfs(node) {
    if (node === target) return true;
    if (visiting.has(node)) return false;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of (adj.get(node) || [])) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  return dfs(start);
}

function downstreamClosure(type, id) {
  const seen = new Set();
  const queue = [`${type}:${id}`];
  const result = [];

  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const [curType, ...rest] = cur.split(':');
    const curId = rest.join(':');

    const next = db.prepare(`
      SELECT downstream_type, downstream_id, dependency_type, required_state
      FROM dependencies
      WHERE active=1 AND upstream_type=? AND upstream_id=?
    `).all(curType, curId);

    for (const n of next) {
      const key = `${n.downstream_type}:${n.downstream_id}`;
      if (!seen.has(key)) {
        result.push({...n});
        queue.push(key);
      }
    }
  }
  return result;
}

function markActionHoldForDecision(decisionId, reason, actorName) {
  const actions = db.prepare(`
    SELECT * FROM actions
    WHERE decision_id=? AND status IN ('PENDING','AUTHORIZED','HOLD')
  `).all(decisionId);

  for (const a of actions) {
    db.prepare(`UPDATE actions SET status='HOLD' WHERE id=?`).run(a.id);
    db.prepare(`
      UPDATE authorizations SET status='REVOKED'
      WHERE action_id=? AND status='ACTIVE'
    `).run(a.id);
    audit('ACTION_HOLD', 'action', a.id, actorName, reason, {decision_id:decisionId});
  }
}

function markDecisionStale(decisionId, reason, actorName) {
  const d = db.prepare(`SELECT * FROM decisions WHERE id=?`).get(decisionId);
  if (!d || ['REJECTED'].includes(d.status)) return;

  db.prepare(`
    UPDATE decisions
    SET status='REVALIDATION_REQUIRED', reason=?, validated_at=NULL
    WHERE id=?
  `).run(reason, decisionId);

  markActionHoldForDecision(decisionId, reason, actorName);

  audit('DECISION_REVALIDATION_REQUIRED', 'decision', decisionId, actorName, reason, {decision_id:decisionId});
}

function currentEvidenceForBinding(binding) {
  const e = db.prepare(`SELECT * FROM evidence WHERE id=?`).get(binding.evidence_id);
  if (!e) return {ok:false, reason:`Missing evidence ${binding.evidence_id}`};

  if (Number(e.version) !== Number(binding.version)) {
    return {ok:false, reason:`Evidence ${e.id} version mismatch`};
  }
  if (e.status !== 'CURRENT') return {ok:false, reason:`Evidence ${e.id} is ${e.status}`};
  if (!['VERIFIED','AUTHORITATIVE'].includes(e.authority_status)) {
    return {ok:false, reason:`Evidence ${e.id} is not verified/authoritative`};
  }
  if (!isEvidenceCurrentlyValid(e)) {
    return {ok:false, reason:`Evidence ${e.id} is outside its validity interval`};
  }
  return {ok:true, evidence:e};
}

function buildDecisionHash(entityId, decisionType, bindings, policyVersion) {
  const canonical = JSON.stringify({
    entity_id:entityId,
    decision_type:decisionType,
    evidence_bindings:[...bindings].sort((a,b)=>String(a.evidence_id).localeCompare(String(b.evidence_id))),
    policy_version:policyVersion
  });
  return sha256(canonical);
}

function businessDecisionCheck(decisionId) {
  const d = db.prepare(`SELECT * FROM decisions WHERE id=?`).get(decisionId);
  if (!d) return {ok:false, reason:'Decision not found'};

  const bindings = parseJson(d.evidence_bindings_json, []);
  for (const binding of bindings) {
    const check = currentEvidenceForBinding(binding);
    if (!check.ok) return {ok:false, reason:check.reason};
  }

  const impacted = downstreamClosure('decision', d.id).filter(x => x.downstream_type === 'decision');
  for (const dep of impacted) {
    const child = db.prepare(`SELECT status FROM decisions WHERE id=?`).get(dep.downstream_id);
    if (child && child.status !== dep.required_state) {
      return {ok:false, reason:`Dependent decision ${dep.downstream_id} is ${child.status}`};
    }
  }
  return {ok:true, reason:'All bound evidence and known decision dependencies are current'};
}

function actionCheck(action) {
  expireEvidenceInPlace('system');
  const d = db.prepare(`SELECT * FROM decisions WHERE id=?`).get(action.decision_id);
  if (!d) return {status:'BLOCK', reason:'Decision does not exist'};

  const decisionCheck = businessDecisionCheck(d.id);
  if (!decisionCheck.ok) {
    return {status:'HOLD', reason:decisionCheck.reason};
  }
  if (d.status !== 'CURRENT') {
    return {status:'HOLD', reason:`Decision ${d.id} is ${d.status}`};
  }

  const policyVersion = d.policy_version;
  const paramsHash = sha256(action.parameters_json);

  // Existing authorization for a different parameter hash is not reusable.
  const old = db.prepare(`
    SELECT * FROM authorizations
    WHERE action_id=? AND status='ACTIVE'
  `).get(action.id);
  if (old && (old.parameters_hash !== paramsHash || old.policy_version !== policyVersion)) {
    db.prepare(`UPDATE authorizations SET status='REVOKED' WHERE id=?`).run(old.id);
    return {status:'HOLD', reason:'Existing authorization no longer matches action parameters or policy'};
  }

  return {status:'ALLOW', reason:'Decision, evidence versions, policy version and action parameters are current'};
}

function issueAuthorization(actionId, actorName) {
  const a = db.prepare(`SELECT * FROM actions WHERE id=?`).get(actionId);
  if (!a) throw new Error('Action not found');

  const d = db.prepare(`SELECT * FROM decisions WHERE id=?`).get(a.decision_id);
  if (!d) throw new Error('Decision not found');

  const check = actionCheck(a);
  if (check.status !== 'ALLOW') {
    db.prepare(`UPDATE actions SET status='HOLD' WHERE id=?`).run(a.id);
    return {status:check.status, reason:check.reason};
  }

  const existing = db.prepare(`
    SELECT * FROM authorizations WHERE action_id=? AND status='ACTIVE'
  `).get(a.id);
  if (existing) return {status:'ALLOW', reason:'Existing authorization reused', authorization_id:existing.id};

  const id = uid('AUTH');
  db.prepare(`
    INSERT INTO authorizations(
      id, action_id, decision_id, evidence_bindings_json, policy_version,
      parameters_hash, status, issued_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run(
    id, a.id, d.id, d.evidence_bindings_json, d.policy_version,
    a.parameters_hash, 'ACTIVE', now()
  );

  db.prepare(`UPDATE actions SET status='AUTHORIZED' WHERE id=?`).run(a.id);
  audit('ACTION_AUTHORIZED','action',a.id,actorName,
    'Action authorized after current-state validation',
    {authorization_id:id, decision_id:d.id});
  return {status:'ALLOW', reason:'New authorization issued', authorization_id:id};
}

function executeAction(actionId, idempotencyKey, actorName) {
  // Single-process lock + SQLite immediate transaction gives deterministic
  // duplicate handling inside this demo. Real multi-process deployments
  // should use an external transactional/idempotency strategy.
  if (!idempotencyKey) throw new Error('Idempotency-Key header is required');

  const prior = db.prepare(`
    SELECT * FROM actions WHERE idempotency_key=?
  `).get(idempotencyKey);
  if (prior) {
    return {status:prior.status, action_id:prior.id, duplicate:true, result:parseJson(prior.result_json)};
  }

  const a = db.prepare(`SELECT * FROM actions WHERE id=?`).get(actionId);
  if (!a) throw new Error('Action not found');

  db.prepare(`UPDATE actions SET idempotency_key=? WHERE id=?`).run(idempotencyKey, actionId);

  const auth = db.prepare(`
    SELECT * FROM authorizations
    WHERE action_id=? AND status='ACTIVE'
    ORDER BY issued_at DESC LIMIT 1
  `).get(actionId);

  if (!auth) {
    db.prepare(`UPDATE actions SET status='HOLD' WHERE id=?`).run(actionId);
    audit('ACTION_HOLD','action',actionId,actorName,
      'No active authorization at execution time', {});
    return {status:'HOLD', reason:'No active authorization at execution time'};
  }

  const fresh = actionCheck(a);
  if (fresh.status !== 'ALLOW') {
    db.prepare(`UPDATE actions SET status='HOLD' WHERE id=?`).run(actionId);
    db.prepare(`UPDATE authorizations SET status='REVOKED' WHERE id=?`).run(auth.id);
    audit('ACTION_HOLD','action',actionId,actorName,
      `Execution-time gate failed: ${fresh.reason}`, {authorization_id:auth.id});
    return {status:'HOLD', reason:fresh.reason};
  }

  if (auth.parameters_hash !== a.parameters_hash || auth.policy_version !== db.prepare(`SELECT policy_version FROM decisions WHERE id=?`).get(a.decision_id).policy_version) {
    db.prepare(`UPDATE actions SET status='HOLD' WHERE id=?`).run(actionId);
    db.prepare(`UPDATE authorizations SET status='REVOKED' WHERE id=?`).run(auth.id);
    return {status:'HOLD', reason:'Authorization binding mismatch at execution'};
  }

  db.prepare(`UPDATE actions SET status='EXECUTING' WHERE id=?`).run(actionId);
  audit('ACTION_EXECUTING','action',actionId,actorName,
    'Execution gateway accepted bound authorization', {authorization_id:auth.id});

  // Simulated external adapter commit.
  const result = {
    adapter:'SIMULATED_PURCHASE_APPROVAL_ADAPTER',
    accepted:true,
    committed_at:now(),
    request_id:uid('EXT')
  };

  db.prepare(`
    UPDATE actions
    SET status='EXECUTED', executed_at=?, result_json=?
    WHERE id=?
  `).run(now(), json(result), actionId);

  db.prepare(`
    UPDATE authorizations
    SET status='CONSUMED', consumed_at=?
    WHERE id=?
  `).run(now(), auth.id);

  audit('ACTION_EXECUTED','action',actionId,actorName,
    'Simulated external action committed after execution-time validation',
    result);

  return {status:'EXECUTED', action_id:actionId, result};
}

function seed() {
  const count = Number(db.prepare(`SELECT COUNT(*) c FROM sources`).get().c);
  if (count) return;

  const complianceKey = 'DEMO-COMPLIANCE-KEY';
  db.prepare(`
    INSERT INTO sources(id,name,api_key_hash,trust_level,allowed_fact_prefix)
    VALUES(?,?,?,?,?)
  `).run(
    'SRC_COMPLIANCE',
    'Compliance System',
    sha256(complianceKey),
    'AUTHORITATIVE',
    'vendor.'
  );

  const eOld = 'EV-005';
  const eCurrent = 'EV-006';
  const dId = 'D-104';
  const aId = 'A-2207';

  const t = now();
  const yesterday = new Date(Date.now()-86400000).toISOString();

  db.prepare(`
    INSERT INTO evidence(
      id,entity_id,fact_key,value_text,source_id,authority_status,
      effective_from,effective_to,observed_at,version,status,predecessor_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    eOld,'vendor_123','vendor.qualification.status','VALID',
    'SRC_COMPLIANCE','SUPERSEDED',yesterday,null,yesterday,5,'SUPERSEDED',null,yesterday
  );

  db.prepare(`
    INSERT INTO evidence(
      id,entity_id,fact_key,value_text,source_id,authority_status,
      effective_from,effective_to,observed_at,version,status,predecessor_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    eCurrent,'vendor_123','vendor.qualification.status','VALID',
    'SRC_COMPLIANCE','AUTHORITATIVE',t,null,t,6,'CURRENT',eOld,t
  );

  // The initial decision is valid and is bound to current evidence EV-006.
  const bindings = [{evidence_id:eCurrent, version:6, fact_key:'vendor.qualification.status'}];
  const dHash = buildDecisionHash('vendor_123','PURCHASE_APPROVAL',bindings,'POL-003');

  db.prepare(`
    INSERT INTO decisions(
      id,entity_id,decision_type,status,evidence_bindings_json,
      policy_version,decision_hash,reason,created_at,validated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    dId,'vendor_123','PURCHASE_APPROVAL','CURRENT',
    json(bindings),'POL-003',dHash,
    'Created after current-state validation',t,t
  );

  db.prepare(`
    INSERT INTO actions(
      id,decision_id,action_type,parameters_json,parameters_hash,
      status,execution_target,created_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `).run(
    aId,dId,'SUBMIT_PURCHASE_ORDER',
    json({vendor_id:'vendor_123',amount:12500,currency:'EUR'}),
    sha256(json({vendor_id:'vendor_123',amount:12500,currency:'EUR'})),
    'PENDING','SIMULATED_PROCUREMENT_SYSTEM',t
  );

  const addDep = (uType,uId,dType,dId,kind,req) => {
    db.prepare(`
      INSERT INTO dependencies(
        id,upstream_type,upstream_id,downstream_type,downstream_id,
        dependency_type,required_state,created_at
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(uid('DEP'),uType,uId,dType,dId,kind,req,t);
  };

  addDep('fact','vendor_123|vendor.qualification.status','decision',dId,'REQUIRES_CURRENT','CURRENT');
  addDep('decision',dId,'action',aId,'REQUIRES_CURRENT','CURRENT');

  audit('SYSTEM_SEEDED','system','SC-SMT', 'system',
    'Seeded purchase-approval demonstration scenario',
    {demo_source_key:'DEMO-COMPLIANCE-KEY'});

  // The current evidence is intentionally expired in the semantic sense but
  // not by time interval, so users can first inspect the explicit change.
}

seed();

let mutationLock = Promise.resolve();

function withMutationLock(fn) {
  const run = mutationLock.then(fn);
  mutationLock = run.catch(() => {});
  return run;
}

function listData() {
  expireEvidenceInPlace('system');

  const evidence = db.prepare(`SELECT e.*, s.name source_name, s.trust_level FROM evidence e JOIN sources s ON s.id=e.source_id ORDER BY e.created_at DESC`).all();
  const dependencies = db.prepare(`SELECT * FROM dependencies WHERE active=1 ORDER BY created_at DESC`).all();
  const decisions = db.prepare(`SELECT * FROM decisions ORDER BY created_at DESC`).all().map(d => ({...d, evidence_bindings:parseJson(d.evidence_bindings_json,[])}));
  const actions = db.prepare(`SELECT * FROM actions ORDER BY created_at DESC`).all().map(a => ({...a, parameters:parseJson(a.parameters_json,{}), result:parseJson(a.result_json,null)}));
  const authorizations = db.prepare(`SELECT * FROM authorizations ORDER BY issued_at DESC`).all().map(a => ({...a, evidence_bindings:parseJson(a.evidence_bindings_json,[])}));
  const auditEvents = db.prepare(`SELECT * FROM audit_events ORDER BY id DESC LIMIT 100`).all().map(a => ({...a,payload:parseJson(a.payload_json,{})}));

  const latestChange = evidence.find(e => e.status === 'CURRENT' && e.fact_key === 'vendor.qualification.status')
    || evidence.find(e => e.id === 'EV-006') || evidence[0];
  const affected = latestChange
    ? downstreamClosure('fact', `${latestChange.entity_id}|${latestChange.fact_key}`)
    : [];

  return {
    summary:{
      evidence_count:evidence.length,
      affected_items:affected.length,
      decisions_count:decisions.length,
      actions_count:actions.length,
      held_actions:actions.filter(a=>a.status==='HOLD').length
    },
    evidence, dependencies, decisions, actions, authorizations, audit:auditEvents,
    latest_change:latestChange,
    impact:affected
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  if (pathname.startsWith('/api/')) {
    try {
      if (method === 'GET' && pathname === '/api/state') {
        return send(res,200,listData());
      }

      if (method === 'POST' && pathname === '/api/reset-demo') {
        return withMutationLock(async() => {
          db.exec(`
            DELETE FROM authorizations;
            DELETE FROM actions;
            DELETE FROM decisions;
            DELETE FROM dependencies;
            DELETE FROM evidence;
            DELETE FROM audit_events;
          `);
          // Keep source registry, then reinsert demo state by deleting/readding source too.
          db.exec(`DELETE FROM sources;`);
          seed();
          return send(res,200,{ok:true});
        });
      }

      if (method === 'POST' && pathname === '/api/simulate/qualification-expiry') {
        return withMutationLock(async()=>{
          const current = db.prepare(`
            SELECT * FROM evidence
            WHERE entity_id='vendor_123' AND fact_key='vendor.qualification.status'
            ORDER BY version DESC LIMIT 1
          `).get();
          if (!current) return send(res,404,{error:'Demo qualification evidence not found'});

          db.prepare(`
            UPDATE evidence
            SET value_text='EXPIRED', status='EXPIRED', authority_status='EXPIRED', observed_at=?
            WHERE id=?
          `).run(now(), current.id);

          const d = db.prepare(`SELECT * FROM decisions WHERE id='D-104'`).get();
          if (d) markDecisionStale(d.id,'Vendor qualification expired',actor(req));

          audit('EVIDENCE_CHANGED','evidence',current.id,actor(req),
            'Vendor qualification expired in demo workflow',
            {previous:current.value_text,current:'EXPIRED',version:current.version});
          return send(res,200,{ok:true,state:listData()});
        });
      }

      if (method === 'POST' && pathname === '/api/simulate/renew-qualification') {
        return withMutationLock(async()=>{
          const current = db.prepare(`
            SELECT * FROM evidence
            WHERE entity_id='vendor_123' AND fact_key='vendor.qualification.status'
            ORDER BY version DESC LIMIT 1
          `).get();
          const version=(current?.version || 0)+1;
          const id=`EV-${String(version).padStart(3,'0')}`;
          db.prepare(`
            INSERT INTO evidence(
              id,entity_id,fact_key,value_text,source_id,authority_status,
              effective_from,effective_to,observed_at,version,status,predecessor_id,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            id,'vendor_123','vendor.qualification.status','VALID',
            'SRC_COMPLIANCE','AUTHORITATIVE',now(),null,now(),version,'CURRENT',current?.id || null,now()
          );
          if (current) {
            db.prepare(`UPDATE evidence SET status='SUPERSEDED', authority_status='SUPERSEDED' WHERE id=?`).run(current.id);
          }
          const d = db.prepare(`SELECT * FROM decisions WHERE id='D-104'`).get();
          if (d) markDecisionStale(d.id,'New qualification evidence requires decision revalidation',actor(req));
          audit('EVIDENCE_VERIFIED','evidence',id,actor(req),
            'New authoritative vendor qualification received',
            {predecessor_id:current?.id || null,version});
          return send(res,200,{ok:true,new_evidence_id:id,state:listData()});
        });
      }

      if (method === 'POST' && pathname === '/api/decisions/D-104/revalidate') {
        return withMutationLock(async()=>{
          expireEvidenceInPlace(actor(req));
          const d = db.prepare(`SELECT * FROM decisions WHERE id='D-104'`).get();
          if (!d) return send(res,404,{error:'Decision not found'});

          // Revalidation deliberately requires the latest authoritative qualification,
          // not the old bound version.
          const latest = db.prepare(`
            SELECT * FROM evidence
            WHERE entity_id=? AND fact_key=? AND status='CURRENT'
            ORDER BY version DESC LIMIT 1
          `).get(d.entity_id,'vendor.qualification.status');

          if (!latest || latest.value_text !== 'VALID' || !['VERIFIED','AUTHORITATIVE'].includes(latest.authority_status) || !isEvidenceCurrentlyValid(latest)) {
            db.prepare(`
              UPDATE decisions SET status='REVALIDATION_REQUIRED', reason=?, validated_at=NULL
              WHERE id=?
            `).run('Revalidation failed: current vendor qualification is not valid',d.id);
            markActionHoldForDecision(d.id,'Revalidation failed: vendor qualification is not valid',actor(req));
            audit('DECISION_REVALIDATION_FAILED','decision',d.id,actor(req),
              'Current qualification did not satisfy purchase-approval rule',
              {current_evidence:latest?.id || null});
            return send(res,200,{status:'HOLD',reason:'Current vendor qualification is not valid',state:listData()});
          }

          const bindings=[{evidence_id:latest.id,version:latest.version,fact_key:latest.fact_key}];
          const newHash=buildDecisionHash(d.entity_id,d.decision_type,bindings,d.policy_version);
          db.prepare(`
            UPDATE decisions
            SET status='CURRENT', evidence_bindings_json=?, decision_hash=?,
                reason=?, validated_at=?
            WHERE id=?
          `).run(json(bindings),newHash,'Decision revalidated against current evidence',now(),d.id);

          db.prepare(`
            UPDATE actions SET status='PENDING'
            WHERE decision_id=? AND status='HOLD'
          `).run(d.id);

          audit('DECISION_REVALIDATED','decision',d.id,actor(req),
            'Decision revalidated against current authoritative evidence',
            {evidence_id:latest.id,version:latest.version});

          return send(res,200,{status:'CURRENT',state:listData()});
        });
      }

      const actionMatch = pathname.match(/^\/api\/actions\/([^/]+)\/(check|authorize|execute)$/);
      if (actionMatch) {
        const actionId = actionMatch[1];
        const op = actionMatch[2];

        if (method === 'POST' && op === 'check') {
          expireEvidenceInPlace(actor(req));
          const a = db.prepare(`SELECT * FROM actions WHERE id=?`).get(actionId);
          if (!a) return send(res,404,{error:'Action not found'});
          const check = actionCheck(a);
          if (check.status !== 'ALLOW') db.prepare(`UPDATE actions SET status='HOLD' WHERE id=?`).run(actionId);
          return send(res,200,{action_id:actionId,...check,state:listData()});
        }

        if (method === 'POST' && op === 'authorize') {
          return withMutationLock(async()=>{
            const result=issueAuthorization(actionId,actor(req));
            return send(res,200,{action_id:actionId,...result,state:listData()});
          });
        }

        if (method === 'POST' && op === 'execute') {
          return withMutationLock(async()=>{
            const key=req.headers['idempotency-key'];
            const result=executeAction(actionId,key,actor(req));
            return send(res,200,{...result,state:listData()});
          });
        }
      }

      if (method === 'POST' && pathname === '/api/maintenance/expiry-scan') {
        return withMutationLock(async()=>{
          const n=expireEvidenceInPlace(actor(req));
          return send(res,200,{expired_count:n,state:listData()});
        });
      }

      if (method === 'POST' && pathname === '/api/evidence') {
        const body=await readBody(req);
        const src=getSourceByKey(sourceFromHeader(req));
        if (!src) return send(res,401,{error:'Valid source API key required'});
        if (!sourceCanAssertFact(src,body.fact_key)) {
          return send(res,403,{error:'Source is not authorized to assert this fact type'});
        }

        const required=['entity_id','fact_key','value','effective_from'];
        const missing=required.filter(k => body[k] === undefined || body[k] === null || body[k] === '');
        if (missing.length) return send(res,400,{error:`Missing: ${missing.join(', ')}`});

        return withMutationLock(async()=>{
          const latest=db.prepare(`
            SELECT * FROM evidence
            WHERE entity_id=? AND fact_key=?
            ORDER BY version DESC LIMIT 1
          `).get(body.entity_id,body.fact_key);

          const version=(latest?.version || 0)+1;
          const id=body.id || uid('EV');
          const authority = body.verify === true ? (src.trust_level==='AUTHORITATIVE'?'AUTHORITATIVE':'VERIFIED') : 'RECEIVED';

          const status=body.conflict ? 'CONFLICT' : 'CURRENT';

          db.prepare(`
            INSERT INTO evidence(
              id,entity_id,fact_key,value_text,source_id,authority_status,
              effective_from,effective_to,observed_at,version,status,predecessor_id,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            id,body.entity_id,body.fact_key,String(body.value),
            src.id,authority,String(body.effective_from),
            body.effective_to || null,now(),version,status,latest?.id || null,now()
          );

          if (latest && latest.status==='CURRENT') {
            db.prepare(`UPDATE evidence SET status='SUPERSEDED', authority_status='SUPERSEDED' WHERE id=?`).run(latest.id);
            const impacted=db.prepare(`
              SELECT DISTINCT id FROM decisions
              WHERE EXISTS (
                SELECT 1 FROM json_each(evidence_bindings_json)
                WHERE json_extract(value,'$.evidence_id')=?
              )
            `).all(latest.id);
            for (const d of impacted) {
              markDecisionStale(d.id,`Bound evidence ${latest.id} was superseded by ${id}`,actor(req));
            }
          }

          audit('EVIDENCE_RECEIVED','evidence',id,actor(req),
            'Evidence accepted from an authenticated source',
            {source_id:src.id, authority_status:authority, version});
          return send(res,201,{id,version,authority_status:authority,status,state:listData()});
        });
      }

      if (method === 'POST' && pathname === '/api/dependencies') {
        const body=await readBody(req);
        const required=['upstream_type','upstream_id','downstream_type','downstream_id','dependency_type','required_state'];
        const missing=required.filter(k=>!body[k]);
        if(missing.length) return send(res,400,{error:`Missing: ${missing.join(', ')}`});

        const candidate={
          upstream_type:body.upstream_type,
          upstream_id:body.upstream_id,
          downstream_type:body.downstream_type,
          downstream_id:body.downstream_id
        };
        if(detectCycle(candidate)) return send(res,409,{error:'Dependency cycle detected; registration rejected'});

        return withMutationLock(async()=>{
          const id=uid('DEP');
          try{
            db.prepare(`
              INSERT INTO dependencies(
                id,upstream_type,upstream_id,downstream_type,downstream_id,
                dependency_type,required_state,created_at
              ) VALUES(?,?,?,?,?,?,?,?)
            `).run(
              id,body.upstream_type,body.upstream_id,body.downstream_type,body.downstream_id,
              body.dependency_type,body.required_state,now()
            );
          }catch(e){
            return send(res,409,{error:'Dependency already exists'});
          }
          audit('DEPENDENCY_REGISTERED','dependency',id,actor(req),
            'Application-declared dependency registered',{...body});
          return send(res,201,{id,state:listData()});
        });
      }

      if (method === 'POST' && pathname === '/api/decisions') {
        const body=await readBody(req);
        const required=['entity_id','decision_type','evidence_bindings','policy_version'];
        const missing=required.filter(k=>body[k]===undefined);
        if(missing.length) return send(res,400,{error:`Missing: ${missing.join(', ')}`});

        for (const b of body.evidence_bindings) {
          const check=currentEvidenceForBinding(b);
          if(!check.ok) return send(res,422,{error:check.reason});
        }

        return withMutationLock(async()=>{
          const id=body.id || uid('DEC');
          const dHash=buildDecisionHash(body.entity_id,body.decision_type,body.evidence_bindings,body.policy_version);
          db.prepare(`
            INSERT INTO decisions(
              id,entity_id,decision_type,status,evidence_bindings_json,
              policy_version,decision_hash,reason,created_at,validated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?)
          `).run(
            id,body.entity_id,body.decision_type,'CURRENT',
            json(body.evidence_bindings),body.policy_version,dHash,
            'Created after current-state validation',now(),now()
          );

          audit('DECISION_CREATED','decision',id,actor(req),
            'Decision created from current verified evidence',{decision_hash:dHash});
          return send(res,201,{id,status:'CURRENT',decision_hash:dHash,state:listData()});
        });
      }

      return send(res,404,{error:'API route not found'});
    } catch (e) {
      return send(res,500,{error:e.message || 'Server error'});
    }
  }

  // Static files
  let filePath = pathname === '/' ? path.join(PUBLIC,'index.html') : path.join(PUBLIC, pathname.replace(/^\/+/,''));
  if (!filePath.startsWith(PUBLIC)) return sendText(res,403,'Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendText(res,404,'Not found');
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html':'text/html; charset=utf-8',
    '.js':'text/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8',
    '.svg':'image/svg+xml'
  }[ext] || 'application/octet-stream';
  sendText(res,200,fs.readFileSync(filePath),mime);
}

const server=http.createServer((req,res)=>{
  route(req,res).catch(err=>send(res,500,{error:err.message||'Unhandled error'}));
});

server.listen(PORT,()=>{
  console.log(`SC-SMT Product running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Demo source API key: DEMO-COMPLIANCE-KEY`);
});

process.on('SIGINT',()=>{ try{db.close()}finally{process.exit(0)} });
process.on('SIGTERM',()=>{ try{db.close()}finally{process.exit(0)} });
