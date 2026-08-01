# `micro-ledger`

Double-entry accounting for the estate: accounts, journal entries, postings, a balances projection,
reservations, and the reconciliation run that freezes withdrawals when the two sides of the money
invariant stop agreeing. It is the financial source of truth, and it is deliberately the thing no
product writes to directly — every posting arrives through a typed API from a service that holds a
service token, never from a browser.

> **Nothing in this service is reachable by a user.** `authorise()` refuses any principal whose
> `kind` is not `service`, before the scope check and for every domain route
> (`src/server.ts:575`). A user token presented to `GET /accounts/:subject/balances` gets the same
> 403 as a service token missing `ledger:read`. That is not an omission: `wallet` is what a user
> talks to and the ledger is what `wallet` talks to, so a route that quietly accepted a user token
> would be a route through which a browser could read another subject's balances. The estate has
> already recorded the consequence — `micro-ledger` has no third-party-reachable surface at all
> (`docs/ecosystem/18-build-status.md` §3.3d, item 5), which is correct and worth stating rather
> than discovering.

> **It also holds no idea of "how much money there is" that it cannot re-derive.** `balances` is a
> projection (`src/migrations.ts:392`), rebuilt nightly by replaying the journal into
> `balances_shadow` and compared row by row; a disagreement is logged `fatal` and **not repaired**,
> because overwriting the projection would destroy the evidence of how the two came apart
> (`src/jobs.ts:204-231`).

---

## The guarantee this repository exists for

Σ debits = Σ credits, **per entry, per asset**, enforced by a `DEFERRABLE INITIALLY DEFERRED`
constraint trigger rather than by a handler (`src/migrations.ts:324` on `journal_entries`,
`src/migrations.ts:333` on `postings`, function at `src/migrations.ts:265`).

Why it is in the schema and not in `postEntry`:

* **An entry is several INSERTs.** It is unbalanced between the first posting and the last, so an
  immediate check would refuse every legal entry. Deferring to `COMMIT` means the check runs after
  the transaction has finished writing and before it is durable — there is no window in which an
  unbalanced entry exists (`src/migrations.ts:250-255`).
* **It binds a caller the application cannot see.** A handler-level rule holds for traffic that
  went through the handler. This one holds against a psql session, a migration, a future service
  and a bug in this one.
* **Per asset, not per entry.** A conversion debits EMBER and credits Shards in one atomic entry
  and those two totals have no arithmetic relationship. Summing across assets would make a nonsense
  entry balance and a correct one fail (`src/migrations.ts:257-263`).

The proof is a test that **bypasses this service entirely** and drives the tables with raw SQL:
three inserts succeed, `insertsSucceeded` is asserted `true` because "the check belongs at COMMIT",
and the `COMMIT` fails with `does not balance for SHARD: debits 100, credits 99, out by 1`, leaving
nothing behind (`src/entries.test.ts:129-172`). A second test appends a posting to an
already-committed entry **in a later transaction** and is refused too, which is why the trigger is
on `postings` as well (`src/entries.test.ts:192-209`). The file says why in its header: a suite that
only ever posts through `postEntry` would prove that `validateEntryRequest` works, not that the
ledger is safe (`src/entries.test.ts:1-8`).

---

## Routes

Read out of `src/server.ts`. Every domain route requires a **service** token with the named scope;
there is no user-facing route on this service.

| Method | Path | Who | Scope | Idempotency | What it does |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/livez` | **anyone** | — | — | liveness; makes no `authorise()` call (`src/server.ts:324`) |
| `GET` | `/readyz` | **anyone** | — | — | 200 ready / 503 not; makes no `authorise()` call (`src/server.ts:326`) |
| `GET` | `/metrics` | **anyone** | — | — | Prometheus text; makes no `authorise()` call (`src/server.ts:331`) — see Known gaps |
| `POST` | `/entries` | service | `ledger:post` | **required**, in the body | posts a journal entry; 201 fresh, **200 on a replay** so a caller can tell whether its retry did the work (`src/server.ts:346`, status at `:363`) |
| `GET` | `/entries` | service | `ledger:read` | — | cursor page, filterable by `originatingService`, `correlationId`, `kind` (`src/server.ts:369`) |
| `GET` | `/entries/:id` | service | `ledger:read` | — | one entry with its postings; 404 if absent (`src/server.ts:387`) |
| `POST` | `/entries/:id/reverse` | service | `ledger:post` | **required**, in the body | writes a **new** reversing entry with `reverses_entry_id` set; never edits the original (`src/server.ts:394`) |
| `POST` | `/reservations` | service | `ledger:reserve` | **required**, in the body | moves value to a reserved account; the reservation **is** the entry, so `reservationId` is the entry id (`src/server.ts:431`, note at `:461`) |
| `POST` | `/reservations/:id/release` | service | `ledger:reserve` | **required**, in the body | releases a reservation; a second release is 409 `already_released` (`src/server.ts:470`) |
| `GET` | `/accounts/:subject/balances` | service | `ledger:read` | — | balances for one subject; the subject is percent-decoded because it is `user:<uuid>` (`src/server.ts:499`) |
| `GET` | `/trial-balance` | service | `ledger:read` | — | Σ\|debits − credits\| across every asset. **200 even when it is not zero** — the caller asked what the trial balance is and this is the answer; a 500 would deny a monitor the number it exists to read (`src/server.ts:513`, reasoning at `:523`) |
| `GET` | `/reconciliation` | service | `ledger:read` | — | the latest run per asset plus the current freezes (`src/server.ts:528`) |

**Three routes make no `authorise()` call**: `/livez`, `/readyz` and `/metrics`
(`src/server.ts:324`, `:326`, `:331`). A client that sends a token to them is not refused — they
simply never look at it.

**The idempotency key is a body field, not a header.** Every mutating route reads
`idempotencyKey` out of the JSON body and it is `requireString`, so it is mandatory
(`src/server.ts:692` for `/entries`, `:408`, `:446`, `:483` for the others). There is **no**
`Idempotency-Key` header path anywhere in this repository — a caller that sends the header and omits
the field gets a 400 `invalid_entry`. The stored key is namespaced by the calling service, and the same value is also
stored on `journal_entries.idempotency_key` so the unique constraint and the claim table agree
(`src/idempotency.ts:102`).

Three scopes rather than one `ledger:write`, because posting money, reserving it and reading it are
three different authorities: `market` reserves and reads, `wallet` posts and reads, a reporting job
only reads (`src/server.ts:73-80`).

### Status codes

Grouped by what the caller should do (`src/server.ts:234-248`): **400** the request could not be a
legal entry, **404** something named does not exist, **409** the state refuses it (`insufficient_funds`,
`asset_frozen`, `idempotency_key_reuse`, `idempotency_in_flight`, `already_released`,
`account_conflict`), **500** an invariant fired that should have been unreachable. A bad token is
401; **a verifier that could not reach the JWKS is 503**, because answering 401 there would sign
every service in the estate out because identity is having a bad minute (`src/server.ts:268`).

Amounts cross the wire as **strings**. A JSON number is accepted only when it is already a safe
integer; beyond that the value has already lost its low bits before this code ran, so it is refused
with an error that says to send a string (`src/server.ts:629`).

---

## Background work

Leased jobs only. There is no `setInterval` doing domain work in this repository and CI greps for
one. **The lease key names the contended resource, not the row** (`src/jobs.ts:9-31`).

| Job | Lease key | Cadence | What two replicas do |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1s | one claims the stream; the other finds nothing. Two relays would deliver one batch to one subscriber twice (`src/jobs.ts:79`) |
| `ledger.reconcile` | `asset:<code>` | 15min | keyed per asset because assets genuinely parallelise. Keyed on the run id instead would let two runs of one asset race to set and clear its freeze, and **a freeze cleared by a stale run is a withdrawal path reopened against drift that still exists** (`src/jobs.ts:85-90`, reasoning at `:17-23`) |
| `ledger.balances.rebuild` | `global` | 24h | `balances_shadow` is one table for the whole chart; two rebuilds would interleave DELETE and INSERT and report mismatches that are artefacts of each other (`src/jobs.ts:94`) |
| `ledger.idempotency.reap` | `global` | 24h | nothing breaks, but two reapers is two long DELETEs competing for row locks at the head of every posting request (`src/jobs.ts:96`) |

Fifteen minutes for reconciliation is a deliberate bound: it is the only thing that catches a
liability minted against no custody position, and the window between runs is the window in which
such a liability is withdrawable (`src/jobs.ts:81-84`).

A recurring job re-arms itself from the runner's **completion event**, not from inside its own
handler — the runner deletes the row after the handler returns, so a self-enqueue would be deleted a
moment later and the schedule would stop (`src/jobs.ts:112-122`). **A dead-lettered recurring job is
deliberately not re-armed**: the row stays, `jobs_dead_total` increments and `jobs_overdue` climbs,
which is how an operator finds out. A reconciliation job silently rescheduled after exhausting its
attempt budget is a ledger that has stopped being checked (`src/jobs.ts:119-122`).

---

## The database

`jobs`, `outbox`, `event_subscriptions`, `outbox_deliveries`, `inbox`, `accounts`,
`journal_entries`, `postings`, `balances`, `idempotency_keys`, `reconciliation_runs`,
`asset_freezes`, `balances_shadow` — versioned migrations 1–10 in `src/migrations.ts`, run only by
`src/migrator.ts`. `index.ts` asserts the version and refuses to serve below it
(`src/index.ts:67`).

`src/migrations.ts:12-34` states the design plainly: 04-domain-model.md §2.2 requires these
invariants "in the database, not in application code", because the thing this replaces —
`forge-pay`'s single-sided `ledger` table, one `delta` column, no account, no counter-account, no
journal grouping — had nothing for a balancing rule to attach to, and every rule that existed lived
in whichever route happened to write the row. **A rule in a route is a rule the next route forgets.**

| Constraint | Refuses | Why it is here rather than in a handler |
| --- | --- | --- |
| `journal_entries_balanced` / `postings_balanced` (deferred constraint triggers) | an unbalanced entry, and an entry with no postings at all | it holds at `COMMIT` against a caller holding a database connection, which a handler does not. The `postings` copy exists so a posting appended in a *later* transaction cannot unbalance a committed entry (`src/migrations.ts:324`, `:333`, `:329-331`) |
| `ledger_refuse_mutation` triggers **+** `revoke update, delete, truncate` | any UPDATE or DELETE of a posting or an entry | **two mechanisms because they bind different people.** The REVOKE binds every non-owner role; the trigger binds *everyone*, including the owner and a superuser in psql — and the owner is the account most likely to be used for a well-meant quick fix. An audit trail that shows only the fix and not the mistake cannot answer "what did we think was true on the 3rd" (`src/migrations.ts:366`, `:373`, `:381`, reasoning at `:339-352`) |
| `ledger_assert_no_overdraft` (immediate, **AFTER** insert or update) | a liability going negative without `overdraft_allowed` | immediate, not deferred, because paying out value a user never had must fail at the posting and name the account. **AFTER rather than BEFORE is not stylistic**: the projection is written `INSERT … ON CONFLICT DO UPDATE` where the inserted `amount` is the *delta*, and Postgres fires BEFORE-INSERT row triggers before it detects the conflict — a BEFORE trigger would see the raw delta, refuse every debit, and *appear* to work because a debit against an account with no balance row fails for the right reason by accident (`src/migrations.ts:479`, reasoning at `:414-439`) |
| `journal_entries_idempotency_key_uniq` | a second entry under one key, for ever | the uniqueness is the invariant; `idempotency_keys` is only what lets a duplicate be *replayed* rather than refused. Claimed in the same transaction as the postings, so a stored response can never disagree with what committed (`src/migrations.ts:176`, `src/migrations.ts:488-503`) |
| `journal_entries_no_self_reversal_chk` | `reverses_entry_id = id` | a correction is a **new** entry; an entry that reverses itself is not representable (`src/migrations.ts:190`) |
| `journal_entries_kind_chk` | an entry kind nobody enumerated | an unenumerated kind is a category that exists in the data and in no report (`src/migrations.ts:181`) |
| `postings_amount_positive_chk` | amount ≤ 0 | direction carries the sign. A signed amount plus a direction is two ways to say one thing and they drift (`src/migrations.ts:227`) |
| `postings_entry_sequence_uniq` | two postings at one sequence in one entry | replay order is the journal's order; a duplicate sequence makes a rebuild non-deterministic (`src/migrations.ts:231`) |
| `accounts_key_uniq` on `(subject, asset_code, purpose)` | a second account for one key | the account key *is* those three columns; a duplicate splits one balance in two (`src/migrations.ts:142`) |
| `reconciliation_runs_source_chk` | an `observed_source` outside `liability_sum` \| `indexer` | **a run whose observed side is unstated is a run whose green tick means nothing** (`src/migrations.ts:564`, reasoning at `:556-557`) |
| `balances_shadow` carries **no** overdraft trigger and **no** FK | — | deliberate. The shadow is diagnostic: if replaying the journal produces a negative liability that is the single most important thing the job can report, and a constraint aborting the rebuild would suppress exactly the finding the rebuild exists to surface (`src/migrations.ts:597-604`) |

`balances.amount` is held in the account's own **normal** direction, so the number reads as "how
much of this account there is" for a liability and an asset alike and nobody holds the sign
convention in their head twice. It is nonetheless signed, because negative is precisely what the
overdraft trigger exists to refuse (`src/migrations.ts:400-405`).

`reconciliation_runs.drift` is `ledger_custody_total − indexer_observed_total` and **the sign
carries the meaning**: positive means the ledger claims coin the other side does not show — the
shape of a liability minted against no custody position — and negative is an uncredited deposit,
still a bug but one that owes the user rather than the reverse (`src/migrations.ts:538-542`).

---

## Configuration

`.env.example` and `src/env.ts` were cross-checked variable by variable and **agree**; every name in
one appears in the other, and `LEDGER_TEST_DATABASE_URL` is correctly commented out as a
test-only knob. A known placeholder value is refused at boot rather than accepted and forged later
(`src/env.ts:56-66`).

| Variable | Default | If it is wrong or missing |
| --- | --- | --- |
| `PORT` | `4000` | must be an integer 1–65535 or boot fails (`src/env.ts:182`) |
| `NODE_ENV` | `development` | labelling only (`src/env.ts:183`) |
| `LOG_LEVEL` | `info` | anything outside `debug\|info\|warn\|error` refuses to start (`src/env.ts:164`) |
| `CLOUDSFORGE_TAG` | `dev` | the version reported in logs and `/livez` is wrong (`src/env.ts:184`) |
| `LEDGER_DATABASE_URL` | — | **required**; the service refuses to start (`src/env.ts:186`). Rule 1 — CI greps for any second connection-string variable, so adding one fails the build rather than review (`src/env.ts:128-130`) |
| `LEDGER_DATABASE_POOL_MAX` | `10` | integer 1–500; too low serialises postings, too high exhausts Postgres connections (`src/env.ts:187`) |
| `IDENTITY_JWKS_URL` | — | **required**. Unreachable at runtime → every domain route answers 503, not 401 (`src/env.ts:188`, `src/server.ts:268`) |
| `IDENTITY_ISSUER` | — | **required**. Wrong value → every token fails verification and the whole surface is 401 (`src/env.ts:189`) |
| `OUTBOX_SIGNING_SECRET` | — | **required**, ≥24 chars, placeholders refused. Wrong → subscribers cannot verify an event came from us; changing it invalidates in-flight signatures (`src/env.ts:190`) |
| `INSTANCE_ID` | hostname | names this replica in `jobs.locked_by`; wrong only makes a stuck lease harder to attribute (`src/env.ts:191`) |
| `LEDGER_ASSET_TOLERANCE` | `{}` | JSON of asset → smallest-unit string. **An asset absent from the map gets zero tolerance, not infinity** — `withinTolerance` fails closed and this parser must not undo that (`src/env.ts:95`, reasoning at `:83-93`). Set too high and drift stops freezing withdrawals |
| `LEDGER_RECONCILE_ASSETS` | `SHARD,EMBER` | the list actually swept. An asset omitted here is **never reconciled** — explicit rather than derived from `accounts` so an operator can read the list without inferring it from data (`src/env.ts:173`, reasoning at `:139-145`) |
| `LEDGER_RECONCILE_NETWORK` | `testnet` | must be `mainnet` or `testnet`; recorded on every run row (`src/env.ts:168`) |
| `LEDGER_IDEMPOTENCY_TTL_DAYS` | `30` | **expiring a key early means the next replay does the work a second time**, so this must outlive every caller's retry horizon rather than be as short as the table would like (`src/env.ts:195`, reasoning at `:148-152`) |
| `LEDGER_TEST_DATABASE_URL` | — | tests only. Unset, every database-backed test **skips**; the database name must contain `test` because the suite truncates |

A configuration failure is reported as one hand-built structured `fatal` line straight to stderr,
because the checks run at import before the logger exists and a bare V8 stack is dropped by the
collector — leaving an operator with a container that exits instantly and no reason
(`src/env.ts:199-221`).

---

## What it talks to

**The ledger makes no outbound call to another CloudsForge service.** Grepping the non-test sources
for `fetch(` finds one hit and it is a `new URL()` base, not a request (`src/server.ts:190`). It has
exactly two network relationships:

| Upstream | What it calls | When it is down |
| --- | --- | --- |
| `micro-identity` | its JWKS document at `IDENTITY_JWKS_URL`, fetched by `@cloudsforge/auth`'s `Verifier` (`src/index.ts:107`) | **fail closed for new tokens, but not fatal.** Every domain route answers **503 `verifier_unavailable`**, never 401 (`src/server.ts:268`). The readiness probe is deliberately **soft** (`src/index.ts:103-107`): marking it hard would remove every service in the estate from its load balancer on one identity blip, which is a cascade, not a safety measure |
| whatever rows are in `event_subscriptions` | signed HMAC event deliveries from the outbox relay (`src/outbox.ts:241`) | **fail open, per subscriber.** A failed delivery records `last_error` and leaves `delivered_at` null; the batch continues and the job succeeds, because one dead subscriber must not stop the stream. The undelivered row is the durable record (`src/outbox.ts:277-284`) |

Callers point the other way: `wallet`, `market`, `billing`, `worlds` and `mint` call *into* this
service with service tokens.

---

## Running it

```bash
pnpm install
pnpm typecheck

# Migrations are a one-shot job and are NEVER run by the service process.
LEDGER_DATABASE_URL=postgres://ledger:ledger@127.0.0.1:55432/ledger pnpm migrate
pnpm start
```

The suite needs a real Postgres. It truncates between cases, so the database name must contain
`test`; without `LEDGER_TEST_DATABASE_URL` every database-backed test **skips** rather than passes.

```bash
docker run -d --rm --name ledger-pg \
  -e POSTGRES_USER=ledger -e POSTGRES_PASSWORD=ledger -e POSTGRES_DB=ledger_test \
  -p 55432:5432 postgres:17-alpine

LEDGER_TEST_DATABASE_URL=postgres://ledger:ledger@127.0.0.1:55432/ledger_test pnpm test
```

**122 `test(` declarations, `node:test` only.** They run against a real database because the most
important controls here are a deferred constraint trigger and two immutability triggers, and none of
them can be proved against a fake. `--test-concurrency=1` is required rather than preferred: every
database test file truncates between cases, `node:test` runs *files* in parallel by default, and a
`TRUNCATE` takes an `AccessExclusiveLock` that deadlocks (40P01) against another file's inserts
(`package.json:14`).

CI is the estate's reusable `service-ci.yml` and **fails the build if the database-backed suite
skipped** (`.github/workflows/ci.yml`), which is what stops a green run that proved nothing.

---

## Known gaps

* **Reconciliation only ever checks the internal half of the invariant.** `reconcileAsset` records
  `observed_source = 'indexer'` when it is handed an `indexerObservedTotal` and `'liability_sum'`
  otherwise (`src/reconcile.ts:101`), and the job **never passes one** — it calls with `assetCode`,
  `chain`, `network` and `tolerance` only (`src/jobs.ts:180-185`). So in production every run
  compares Σ custody accounts against Σ liability accounts *from this same ledger*. That catches a
  liability minted against no custody position, which is the live `convertCoinToEmber` defect
  (`src/reconcile.ts:16-21`), and it catches **nothing** about whether the chain actually holds the
  coin. Wiring `micro-indexer` in adds a caller, not a migration — the column shape is already the
  domain model's (`src/migrations.ts:552-554`).
* **`/metrics` is unauthenticated** (`src/server.ts:331`). `micro-beacon` gates its equivalent and
  presents a token from Prometheus; this service does not, so anything that can reach the port can
  read `ledger_trial_balance_delta`, `ledger_reconciliation_drift` and the per-service posting
  counts. Deployment currently keeps the port off the public network (AD-17 puts the ledger on the
  `vault` network); that is a topology guarantee, not a service one.
* **`ledger.source` — the per-product revenue question.** `ledger_postings_total` is labelled
  `(service, kind)` precisely so "how much did ForgeMint earn" becomes answerable
  (`src/server.ts:98-105`), but the note there records that only `/internal/*` routes populate the
  originating service in the estate today. This service has no `/internal/*` routes at all, so the
  label is only as good as what each caller passes in `originatingService`.
* **No path versioning.** This service serves `/entries`, not `/v1/entries`. The estate is split
  down the middle — `wallet`, `market`, `mint` and `worlds` serve `/v1/…`, `ledger`, `foresight`,
  `pricing`, `activity` and `identity` do not — and the public API is specified as URL-versioned
  with no gateway rewrite defined (`docs/ecosystem/18-build-status.md` §3.3d, item 3).
* **No OpenAPI description.** 11-data-and-contract-strategy.md:288 names one as the mechanism for
  generating the SDK; no artefact exists anywhere in the estate, so `@cloudsforge/sdk` is
  hand-written against verified route tables instead (§3.3d, item 1).
* **`.env.example` and `src/env.ts` disagree on the secret length.** The file says
  `OUTBOX_SIGNING_SECRET` must be "at least 32 random characters" (`.env.example:19`);
  `requiredSecret` is called with no length override, so the enforced minimum is the default **24**
  (`src/env.ts:190`, default at `:55`). The comment is the stricter of the two, so nothing insecure
  follows — but a 26-character secret satisfies the code and contradicts the file. Found while
  writing this and **reported rather than edited**, since the remit of that change was this README.
  `micro-billing`'s `.env.example` carries the identical wording and the identical mismatch.
* **The example secret would boot.** `OUTBOX_SIGNING_SECRET=CHANGE_ME_TO_32_RANDOM_CHARACTERS`
  (`.env.example:21`) is 33 characters and is **not** in the `PLACEHOLDERS` set
  (`src/env.ts:36-45`), so a deployment that copies `.env.example` unchanged starts successfully
  with a signing secret that is in the repository. The guard catches `changeme` and `change-me` but
  not this spelling. `micro-indexer` and `micro-mint` ship the variable **empty**, which fails
  closed and is the better pattern.
* **`BASELINE_VERSION = 0`** (`src/migrations.ts:631`): there is nothing to adopt. Moving value out
  of `forge-pay`'s single-sided `ledger` is a data migration with its own opening-balance entries,
  not a schema baseline, and it has not been written.
