
# SC-SMT Product Behavioral Specification v0.2

## Product promise
Track the evidence behind automated decisions, identify decisions affected by
evidence changes, require revalidation, and prevent connected actions from
executing without a valid authorization.

## First workflow
A new purchase approval requires a currently qualified vendor.

### State vocabulary
Evidence:
- RECEIVED: accepted by an authenticated source but not yet verified
- VERIFIED: source/evidence verification passed
- AUTHORITATIVE: accepted as authoritative for the fact type
- CURRENT: latest active evidence record
- SUPERSEDED: replaced by a newer evidence version
- EXPIRED: validity interval ended
- CONFLICT: conflicting evidence requires resolution
- REJECTED: failed source or evidence rules

Decision:
- CURRENT
- REVALIDATION_REQUIRED
- BLOCKED
- REJECTED

Action:
- PENDING
- HOLD
- AUTHORIZED
- EXECUTING
- EXECUTED
- BLOCKED
- FAILED
- UNKNOWN

## Required behavior
1. A decision must record the evidence versions and policy version used.
2. A changed/superseded/expired bound evidence version marks dependent
   decisions for revalidation.
3. Revalidation must rerun the applicable checks.
4. An invalid, missing, conflicting or non-authoritative required evidence
   cannot yield ALLOW.
5. An action must be routed through the gateway for execution.
6. An active authorization is bound to evidence versions, policy version and
   action parameter hash.
7. The gateway repeats the checks at execution time.
8. An idempotency key is required for an external action request.
9. Dependency cycles are rejected.
10. Expiry is checked even without a new inbound evidence event.

## Coverage rule
The MVP enforces configured rules for registered decisions and actions routed
through the connected gateway. It does not infer arbitrary business
dependencies. Unconfigured or incomplete dependency/evidence coverage must not
be represented as universal knowledge of impact.

## Real external systems
The simulator is deliberately used first. For a real adapter, the product
must define:
- idempotency behavior
- timeout/unknown outcomes
- retry policy
- outbox/reconciliation behavior
- connector authentication
- tenant isolation
- audit retention

## Product acceptance scenarios
- Qualification expires -> dependent approval becomes stale; submission stops.
- Qualification expires by time -> execution-time validity check stops submission.
- Old authorization reused -> gateway rejects it.
- Action parameters change -> previous authorization no longer applies.
- Missing/conflicting evidence -> HOLD.
- Duplicate request -> no duplicate simulated effect.
- Unrelated fact changes -> unrelated approval remains usable.
- New qualification verified -> checks rerun before authorization.
- Dependency is registered against a logical fact, so new evidence versions do not orphan the dependency.
