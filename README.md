
# SC-SMT Product v0.2 — Full Local Implementation

## What this is
A runnable local implementation of the SC-SMT product concept:

Evidence change -> dependency impact -> decision revalidation -> authorization -> execution gate -> audit.

This version replaces the simulated-only prototype with:
- Persistent SQLite storage using Node 22's built-in `node:sqlite`
- Versioned evidence and validity intervals
- Authenticated source ingestion
- Source authority levels
- Explicit application-declared dependencies
- Dependency-cycle rejection
- Decision records with evidence bindings and policy version
- Decision revalidation that reruns business checks
- Action authorization
- Execution-time recheck
- Parameter/policy binding
- Idempotency-key protection
- Audit trail
- Demo UI
- Automated regression tests

## Runtime
Recommended: Node.js 22.x.

No third-party npm dependencies are required.

## Run

```powershell
cd SC-SMT_Product_v0_2_Full_Implementation
node server.js
```

Open:
http://localhost:4173

The database is created automatically at:
`data/sc-smt.sqlite`

Demo source key:
`DEMO-COMPLIANCE-KEY`

## Test

```powershell
node --test
```

## Demo workflow

The database starts with:
- Current qualified vendor evidence `EV-006`
- Current purchase decision `D-104`
- Pending purchase-order action `A-2207`
- A declared logical dependency from vendor qualification to the decision
- A declared dependency from the decision to the action

The UI lets you:
1. inspect the current state;
2. expire the vendor qualification;
3. observe automatic decision invalidation and action HOLD;
4. add a new verified qualification;
5. revalidate the purchase decision;
6. authorize the action;
7. execute it through the simulated gateway;
8. inspect the audit trail.

## Product behavior

### Evidence
Source ingestion requires an authenticated source API key. A source is only
allowed to assert facts matching its configured fact prefix.

Evidence distinguishes:
- received
- verified
- authoritative
- current
- superseded
- expired
- conflict
- rejected

### Dependency
Dependencies are explicitly declared by the application. Each relationship
has:
- upstream node
- downstream node
- dependency type
- required downstream state

Dependency cycles are rejected when registering a new edge.

### Revalidation
Revalidation is not a status flip. It:
- loads the current authoritative evidence;
- checks its validity interval;
- checks required dependencies;
- updates the decision's evidence bindings;
- regenerates the decision hash;
- changes the decision to CURRENT only if checks pass.

### Action gate
An action cannot execute unless an active authorization exists.

The authorization is bound to:
- exact evidence versions
- policy version
- action parameters hash
- decision identity

The gateway repeats validation at execution time.

### Expiry without an event
Evidence can expire because its `effective_to` time passes. The API performs
an expiry scan during safety-sensitive operations, and a maintenance endpoint
is provided for scheduled scans.

### Duplicate execution
The execution endpoint requires `Idempotency-Key`. A repeated key returns the
prior action record rather than creating a duplicate simulated external effect.

## API

GET
- `/api/state`

POST
- `/api/evidence`
- `/api/dependencies`
- `/api/decisions`
- `/api/decisions/D-104/revalidate`
- `/api/actions/:id/check`
- `/api/actions/:id/authorize`
- `/api/actions/:id/execute`
- `/api/maintenance/expiry-scan`
- `/api/simulate/qualification-expiry`
- `/api/reset-demo`

Headers
- `X-SCSMT-Actor`: local actor label
- `X-SCSMT-Source-Key`: evidence-source credential
- `Idempotency-Key`: required for action execution

## Product boundary
This is a full local MVP implementation, not a production-ready enterprise
deployment. A production release still needs:
- real identity provider / RBAC
- secrets management / key rotation
- TLS and network policy
- multi-instance database deployment
- external connector adapters
- durable outbox / delivery semantics for external side effects
- observability
- backup/restore
- rate limiting
- security testing
- tenant isolation
- customer-specific rule configuration

## Research separation
This product code is separate from the frozen SC-SMT research artifacts.
Do not use product modifications to rewrite or replace research runs.
