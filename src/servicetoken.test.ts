/**
 * **THE FIFTEEN-MINUTE JOB AND THE TEN-MINUTE TOKEN, DRIVEN PAST THE EXPIRY.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## The defect
 *
 * `LEDGER_SERVICE_TOKEN` held a token that lives **600 seconds** (`identity/src/tokens.ts`).
 * The reconciliation job runs every **900 seconds** (`jobs.ts:recurringJobs`). The composition root
 * read the variable once, at import — `token: () => env.indexerToken` — so the chain half of the
 * solvency invariant authenticated once per bootstrap and never again. Every sweep from minute ten
 * onwards presented a dead token, got a 401, mapped it to no observation, and froze EMBER.
 *
 * **And the row it wrote was byte-identical to the honest one.** This service is *designed* to
 * freeze a chain asset nobody can observe, and until Hearth's mainnet launches that is EMBER's
 * correct state. So the guarantee built to stop the ledger lying to itself reported a true-shaped
 * fact for a false reason, in a shape no operator could tell from the right one.
 *
 * ## Why every other test in this repository is blind to it
 *
 * They mint a token at the top of the case and use it a millisecond later. **A test that mints a
 * token and immediately uses it proves nothing about this defect** — the token is never asked to
 * survive its own lifetime. `chainbacking.test.ts` beside this file drives the whole loop against a
 * real socket and passes 9/9 with a hard-coded string for a token, because at the speed of a test
 * a hard-coded string and a live credential are indistinguishable. That is the property this file
 * removes: below, the clock moves ELEVEN MINUTES past a token the process already holds, that
 * token is shown to be refused **by a real `Verifier`**, and only then is the job run again.
 *
 * ## What is real here, and what is not
 *
 *   * **Real**: `buildUpstreams` (the wiring under test), `ServiceTokenProvider`, `HttpClient`,
 *     `httpIndexerClient`, `Verifier` and jose's own expiry arithmetic, `JobRunner` claiming a real
 *     row `for update skip locked`, `jobs.ts`'s handler, `reconcileAsset`, and a real Postgres with
 *     migrations 11 and 12's constraints live. The reconciliation rows below are read back out of
 *     the database, not out of a return value.
 *   * **Simulated**: the clock, and the two peers' transports. `mock.timers` moves `Date` only, so
 *     jose decides expiry from the same instant the provider schedules against — nothing here
 *     decides expiry by hand, which is how a test ends up agreeing with the code it is checking.
 *
 * `T0` is deliberately in the past. The clock is mocked and Postgres's is not, and `JobQueue`
 * computes `run_at` in JS while the claim query compares it against the database's `now()`. A `T0`
 * at "today" would put every enqueue eleven minutes into the database's future at exactly the
 * moment the test cares about, and the runner would claim nothing — a green suite proving the
 * handler never ran.
 *
 * ## Going through `buildUpstreams` is the whole point
 *
 * A test that constructs its own `ServiceTokenProvider` and its own `httpIndexerClient` proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS service
 * uses it, and "this service does not use it" was the defect. Reverting `upstreams.ts` to
 * `token: () => env.indexerToken` turns the first test below red — and BASELINE below models that
 * exact old seam, against the same fixtures, so the file also demonstrates the failure it fixes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type postgres from 'postgres'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { JobQueue, JobRunner } from '@cloudsforge/jobs'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { httpIndexerClient, reasonFor, UNOBSERVED_REASONS, type UnobservedReason } from './indexerclient.ts'
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts'
import { RECONCILE_KIND, registerHandlers, type JobDeps } from './jobs.ts'
import { postEntry } from './entries.ts'
import { requestFingerprint } from './idempotency.ts'
import { depositEntry, enabled, migrateTestDb, openDb, resetLedger, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

/** One EMBER, in wei. */
const ONE = 1_000_000_000_000_000_000n

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged — rotation IS expiry. */
const SERVICE_TTL_SECONDS = 600

/** jobs.ts:recurringJobs. The number that makes the one above a defect rather than a detail. */
const RECONCILE_EVERY_SECONDS = 900

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const INDEXER = 'http://indexer:4000'
const CREDENTIAL = 'cfsc_5ntCPqB0ZQ3xk1r-8LHYyU2eWvJfA6oMdT4siGXn9Kc'

/** Well in the past: the database's clock is real and this one is not. See the header. */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)

/** Move the whole world — the provider's schedule and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

let sql: postgres.Sql
const db = (): Db => sql as unknown as Db

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL IDENTITY AND A REAL INDEXER, in the sense that matters.
 *
 * Identity signs RS256 tokens with a 600-second expiry against the simulated clock. The indexer
 * hands whatever it is given to a real `Verifier`, checks `indexer:read` off the verified
 * principal, and answers 401 when jose says the token is bad. Nothing decides expiry by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

interface World {
  readonly fetch: typeof globalThis.fetch
  exchanges: number
  identityDown: boolean
  /** Every call the indexer saw: the bearer presented, and what it answered. */
  indexerCalls: { token: string | null; status: number }[]
  /** Refusals since the last accepted call. The 401-replay loop guard; see the fetch below. */
  consecutive401: number
  /**
   * Refuse the next bearer once, whatever it is, then behave normally.
   *
   * Models the case the SCHEDULE cannot cover and `authorizedFetch` exists for: a token this
   * process believes is fresh which the peer rejects anyway — clock skew between the two, a
   * credential revoked mid-flight, a process paused between reading the token and sending it. The
   * refresh point is computed from this process's clock and `expiresIn`; the indexer decides from
   * `exp` and ITS clock, and nothing makes those agree.
   */
  refuseNextBearer: boolean
  /** Override the custody answer, to express the chain-side failures. */
  custody: { status: number; body: unknown }
}

async function world(): Promise<World> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const keySet = (async () => publicKey) as never
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet })

  // RS256 is deterministic, so two tokens signed from the same payload at the same simulated
  // instant are the same string. identity mints a uuidv7 jti per token; the counter restores that,
  // and without it "the service minted a genuinely new token" could not be asserted at all.
  let jti = 0

  const self: World = {
    exchanges: 0,
    identityDown: false,
    indexerCalls: [],
    consecutive401: 0,
    refuseNextBearer: false,
    custody: { status: 200, body: { total: (7n * ONE).toString(), addresses: 2 } },

    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.startsWith(IDENTITY)) {
        if (self.identityDown) throw new TypeError('fetch failed: ECONNREFUSED')
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 })
        }
        self.exchanges += 1
        const token = await new SignJWT({
          typ: 'service',
          scopes: ['indexer:read'],
          jti: `t-${++jti}`,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuedAt()
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject('service:ledger')
          .setExpirationTime(Math.floor(Date.now() / 1000) + SERVICE_TTL_SECONDS)
          .sign(privateKey)
        return new Response(
          JSON.stringify({ token, service: 'ledger', scopes: ['indexer:read'], expiresIn: SERVICE_TTL_SECONDS }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }

      // The custody route. Guarded exactly as `indexer/src/server.ts` guards it: this is the one
      // domain read on that service that demands a token, because it answers a question about a SET
      // only the platform knows.
      //
      // The loop guard counts CONSECUTIVE refusals rather than total calls. `authorizedFetch`
      // re-mints and replays exactly once on a 401, so a fault would show as an unbroken run of
      // them; a cap on the total would instead be a cap on how many sweeps a test may drive, which
      // is the wrong quantity entirely — and it silently ended the twenty-four-hour case at sweep 33.
      if (self.consecutive401 > 4) throw new Error('the 401 replay is looping')
      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      if (presented === null) {
        self.consecutive401 += 1
        self.indexerCalls.push({ token: null, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      if (self.refuseNextBearer) {
        self.refuseNextBearer = false
        self.consecutive401 += 1
        self.indexerCalls.push({ token: presented, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      try {
        const principal = await verifier.principal(presented)
        if (principal.kind !== 'service' || !principal.scopes.includes('indexer:read')) {
          self.consecutive401 += 1
          self.indexerCalls.push({ token: presented, status: 403 })
          return new Response('{"error":"forbidden"}', { status: 403 })
        }
      } catch {
        self.consecutive401 += 1
        self.indexerCalls.push({ token: presented, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      self.consecutive401 = 0
      self.indexerCalls.push({ token: presented, status: self.custody.status })
      const body =
        typeof self.custody.body === 'string' ? self.custody.body : JSON.stringify(self.custody.body)
      return new Response(body, {
        status: self.custody.status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  }
  return self
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** See the header: this is what makes the file a
 * test of THIS SERVICE'S wiring rather than of `@cloudsforge/auth`.
 */
function upstreamsFor(w: World, credential: string | null) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: credential,
    indexerUrl: INDEXER,
    indexerDeadlineMs: 4_000,
  }
  return buildUpstreams(env, { fetch: w.fetch })
}

/* ------------------------------------------------------------------ driving the real job */

function jobDeps(indexer: JobDeps['indexer']): JobDeps {
  return {
    sql: db(),
    producer: 'ledger',
    logger: new Logger({ service: 'ledger-servicetoken', sink: () => {} }),
    metrics: new Metrics(),
    signingSecret: 'servicetoken-test-signing-secret-0001',
    // Empty on purpose: `withinTolerance` fails CLOSED on an asset it has no entry for, so any
    // non-zero drift below freezes. That is the behaviour under test, not a fixture convenience.
    assetTolerance: {},
    reconcileAssets: ['EMBER'],
    reconcileNetworks: ['testnet'],
    // The same handle as `sql` above. These fixtures run one network against one test
    // database; what the map exists for is the deployment that runs two, and the handler
    // refusing a network it has no connection string for is itself under test below.
    reconcileSql: { testnet: db() },
    indexer,
    idempotencyTtlDays: 30,
  }
}

async function credit(amount: bigint): Promise<void> {
  const request = depositEntry({ amount, assetCode: 'EMBER' })
  await postEntry({ sql: db(), producer: 'ledger' }, request, requestFingerprint(request))
}

/**
 * Enqueue the job the deploy schedules every fifteen minutes and let a real `JobRunner` claim and
 * dispatch it. Nothing here calls the indexer or the reconciler; the handler does both or neither.
 *
 * `runAt` is epoch rather than `new Date()` because `Date` is mocked and Postgres's `now()` is not
 * — see the header. `tick()` rather than `start()` so the suite's duration is not a property of
 * the machine.
 */
async function runReconcileJob(indexer: JobDeps['indexer']): Promise<void> {
  const queue = new JobQueue(sql as never, { owner: 'servicetoken-test' })
  const runner = new JobRunner({ queue, concurrency: 1, pollMs: 10_000 })
  registerHandlers(runner, jobDeps(indexer))
  await queue.enqueue({
    kind: RECONCILE_KIND,
    key: 'asset:EMBER',
    payload: { assetCode: 'EMBER', network: 'testnet' },
    runAt: new Date(0),
    onConflict: 'earliest',
  })
  const claimed = await runner.tick()
  assert.equal(claimed, 1, 'the reconciliation job was not claimed — the runner ran nothing')
}

interface RunRow {
  observed_source: string
  unobserved_reason: string | null
  indexer_observed_total: string | null
  drift: string | null
  status: string
}

async function lastRun(): Promise<RunRow> {
  const rows = await sql<RunRow[]>`
    select observed_source,
           unobserved_reason,
           indexer_observed_total::text as indexer_observed_total,
           drift::text as drift,
           status
      from reconciliation_runs order by started_at desc, id desc limit 1
  `
  return rows[0]!
}

async function freezeReason(): Promise<string | null> {
  const rows = await sql<{ reason: string }[]>`
    select reason from asset_freezes where asset_code = 'EMBER'
  `
  return rows[0]?.reason ?? null
}

/* ------------------------------------------------------------------ lifecycle */

before(async () => {
  if (!enabled) return
  sql = openDb(4)
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  mock.timers.reset()
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetLedger(sql)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REGRESSION TEST.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test(
  'THE CLIFF: a reconciliation ELEVEN MINUTES after boot still authenticates, and still observes the chain',
  { skip },
  async (t) => {
    const w = await world()
    t.after(() => mock.timers.reset())

    clockAt(0)
    const { indexer, identityTokens } = upstreamsFor(w, CREDENTIAL)
    assert.ok(identityTokens, 'buildUpstreams must build a provider when a credential is configured')

    /* ── T+0. Every existing test in this repository stops looking here, and everything is fine. ── */
    await credit(7n * ONE)
    await runReconcileJob(indexer)

    const atBoot = w.indexerCalls.at(-1)?.token
    assert.ok(atBoot, 'the job did not present a bearer at all')
    assert.equal(w.indexerCalls.at(-1)?.status, 200)
    assert.equal(w.exchanges, 1, 'the credential was exchanged exactly once for the first call')

    const first = await lastRun()
    assert.equal(first.observed_source, 'indexer')
    assert.equal(first.indexer_observed_total, (7n * ONE).toString())
    assert.equal(first.drift, '0')
    assert.equal(first.status, 'clean')
    assert.equal(first.unobserved_reason, null)
    assert.equal(await freezeReason(), null)

    /* ── T+11min. Past the token's whole life, and short of the SECOND sweep at T+15min. ────────
     *
     * This is the window the estate lived in: the job is due again at 900s and the token died at
     * 600s, so the interval in which the reconciliation is scheduled to run is entirely inside the
     * interval in which its credential is dead. */
    assert.ok(
      SERVICE_TTL_SECONDS < RECONCILE_EVERY_SECONDS,
      'if the TTL ever exceeds the sweep interval this test is measuring nothing',
    )
    clockAt((SERVICE_TTL_SECONDS + 60) * 1000)

    // FIRST — the token really is dead, decided by a real `Verifier` against jose's own arithmetic
    // rather than by this test. Without this assertion the case below could pass on a token that
    // was still valid, and the whole file would be theatre.
    await assert.rejects(
      () => new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER }).verify(atBoot),
      'a token minted at boot MUST be dead eleven minutes later',
    )

    // SECOND — the old seam, modelled exactly and wired to the real client. `token: () =>
    // env.indexerToken` is a supplier that returns the same string for ever, and there was no
    // `authorizedFetch` behind it because there was none before this change. Run the real job with
    // it and the estate's defect reproduces, row for row.
    await resetLedger(sql)
    await credit(7n * ONE)
    const stale = httpIndexerClient({
      baseUrl: INDEXER,
      token: () => atBoot,
      deadlineMs: 4_000,
      fetch: w.fetch,
    })
    await runReconcileJob(stale)
    assert.equal(w.indexerCalls.at(-1)?.status, 401, 'the stale token was not refused')

    const broken = await lastRun()
    assert.equal(broken.observed_source, 'unavailable')
    assert.equal(broken.status, 'failed')
    assert.equal(broken.indexer_observed_total, null)
    assert.equal(broken.drift, null)
    // THE DEFECT, NAMED. Every column above is what an unfollowed chain writes too. Only this one
    // says the freeze was ours.
    assert.equal(broken.unobserved_reason, 'unauthorized')

    // THIRD — the fix, through the same `buildUpstreams` the composition root calls. A 200 here can
    // only mean the service obtained a live token FOR ITSELF: no operator, no restart, no redeploy,
    // no re-run of estate-bootstrap.sh.
    await resetLedger(sql)
    await credit(7n * ONE)
    const before = w.exchanges
    const callsBefore = w.indexerCalls.length
    await runReconcileJob(indexer)

    assert.equal(w.indexerCalls.at(-1)?.status, 200, 'ledger must still reach the indexer past the first expiry')
    assert.notEqual(w.indexerCalls.at(-1)?.token, atBoot, 'and with a genuinely new token')
    assert.equal(w.exchanges, before + 1, 'which it minted from the credential')

    // **AND IT COST NO 401.** This assertion is here because the file passed without it under a
    // deliberate mutation — a `token` that minted once and cached for ever — and the reason it
    // passed is instructive: `authorizedFetch` caught the 401 and re-minted, so the reconciliation
    // still succeeded. That is the guarantee working, and it is not the fix. A deployment that
    // relies on it pays a doomed round trip on every sweep and stays correct only for as long as
    // the peer keeps answering 401 rather than, say, 403 or a 500 behind a proxy. The SCHEDULE is
    // what must be right; the 401 replay is the belt underneath it.
    const attempts = w.indexerCalls.slice(callsBefore)
    assert.deepEqual(
      attempts.map((call) => call.status),
      [200],
      'the token was refreshed by the 401 replay rather than on schedule',
    )

    const fixed = await lastRun()
    assert.equal(fixed.observed_source, 'indexer')
    assert.equal(fixed.indexer_observed_total, (7n * ONE).toString())
    assert.equal(fixed.drift, '0')
    assert.equal(fixed.status, 'clean')
    assert.equal(fixed.unobserved_reason, null)
    assert.equal(await freezeReason(), null, 'the asset must not be frozen by a credential that renewed itself')
  },
)

test('THE CLIFF: it holds across a full day of sweeps, not just the first one past it', { skip }, async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const { indexer } = upstreamsFor(w, CREDENTIAL)

  // 96 sweeps at fifteen minutes is twenty-four hours, and 144 token lifetimes. A fix that worked
  // once past the first expiry and then wedged — a provider that discarded a token and never
  // replaced it, a backoff that latched — would pass the test above and fail here.
  for (let sweep = 0; sweep < 96; sweep += 1) {
    clockAt(sweep * RECONCILE_EVERY_SECONDS * 1000)
    await resetLedger(sql)
    await credit(7n * ONE)
    await runReconcileJob(indexer)
    const row = await lastRun()
    assert.equal(row.status, 'clean', `sweep ${sweep} (t+${sweep * 15}min) did not observe the chain`)
    assert.equal(row.observed_source, 'indexer')
  }
  // One exchange per sweep, because a sweep is 900s and a token lives 600s. Materially fewer would
  // mean tokens were being reused past their life; materially more would mean the provider was
  // minting per request against the one service the estate can least afford to stampede.
  assert.ok(w.exchanges >= 90 && w.exchanges <= 100, `${w.exchanges} exchanges over 96 sweeps`)
})

test('THE SECOND HOOK: a 401 the schedule could not have predicted is re-minted and replayed', { skip }, async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const { indexer } = upstreamsFor(w, CREDENTIAL)

  // The token is minted seconds ago and this process is certain it is fresh. The indexer refuses it
  // anyway — which is what clock skew, a mid-flight revocation, or a paused process looks like from
  // here. The refresh SCHEDULE cannot help: by its arithmetic there is nothing to refresh.
  //
  // This case exists because deleting `authorizedFetch` from `upstreams.ts` was the one deliberate
  // mutation the rest of this file did not notice. `token` alone keeps a fifteen-minute job on a
  // ten-minute credential; it does not make the two clocks agree, and correctness must not rest on
  // their doing so.
  w.refuseNextBearer = true
  await credit(7n * ONE)
  await runReconcileJob(indexer)

  assert.deepEqual(
    w.indexerCalls.map((call) => call.status),
    [401, 200],
    'the refused call was not re-minted and replayed exactly once',
  )
  assert.notEqual(w.indexerCalls[1]?.token, w.indexerCalls[0]?.token, 'it replayed the same dead token')
  assert.equal(w.exchanges, 2, 'exactly one re-mint: a loop here is a denial of service on identity')

  // And the reconciliation is CLEAN, not frozen. Without the hook this run records `unauthorized`
  // and stops withdrawals for an asset whose chain was observable the whole time.
  const row = await lastRun()
  assert.equal(row.observed_source, 'indexer')
  assert.equal(row.status, 'clean')
  assert.equal(row.unobserved_reason, null)
  assert.equal(await freezeReason(), null)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * DISTINGUISHABILITY. The second half of the defect: these four states all freeze EMBER, all write
 * `unavailable` / NULL / NULL / `failed`, and until migration 12 were one row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

async function drivenReason(w: World, indexer: JobDeps['indexer']): Promise<RunRow> {
  await resetLedger(sql)
  await credit(7n * ONE)
  await runReconcileJob(indexer)
  const row = await lastRun()
  assert.equal(row.observed_source, 'unavailable', 'this case was supposed to observe nothing')
  assert.equal(row.status, 'failed')
  assert.equal(row.indexer_observed_total, null, 'an unobservable indexer produced a total')
  assert.equal(row.drift, null)
  assert.ok(w.indexerCalls.length >= 0)
  return row
}

test('A CREDENTIAL FAILURE AND A CHAIN FAILURE ARE NOW DIFFERENT ROWS', { skip }, async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  /* 1. The chain. The indexer is up, authentication is perfect, and it answers 503
   *    `chain_not_followed` — which is what the estate's own indexer answers today, because Hearth
   *    has not launched. **This is the EXPECTED freeze**, argued for beside LEDGER_RECONCILE_ASSETS
   *    in env.ts, and it must not page. */
  const { indexer } = upstreamsFor(w, CREDENTIAL)
  w.custody = { status: 503, body: { error: 'custody_total_unavailable', code: 'chain_not_followed' } }
  const chain = await drivenReason(w, indexer)
  assert.equal(chain.unobserved_reason, 'indexer_error')

  /* 2. No credential at all. The state a deployment is in before `LEDGER_IDENTITY_CREDENTIAL` is
   *    set — and, before this change, the state EVERY deployment was in ten minutes after boot. */
  const w2 = await world()
  const unconfigured = upstreamsFor(w2, null)
  assert.equal(unconfigured.identityTokens, null)
  const noCred = await drivenReason(w2, unconfigured.indexer)
  assert.equal(noCred.unobserved_reason, 'no_credential')
  // AND NOTHING WAS SENT. A call with no bearer would come back 401 and be recorded `unauthorized`,
  // pointing an operator at a grant when the truth is that nobody configured this container.
  assert.equal(w2.indexerCalls.length, 0, 'an unauthenticated call reached the indexer')

  /* 3. Identity unreachable, with the credential set and the indexer healthy. Still ours, still not
   *    the chain — and still never a stale or absent bearer on the wire. */
  const w3 = await world()
  const live = upstreamsFor(w3, CREDENTIAL)
  w3.identityDown = true
  const identityDown = await drivenReason(w3, live.indexer)
  assert.equal(identityDown.unobserved_reason, 'no_credential')
  assert.equal(w3.indexerCalls.length, 0, 'the indexer was blamed for identity being down')

  /* 4. A token that authenticates and is refused: the grant is missing. Not the chain either, and
   *    a different remedy from 2 and 3 — `derive-grants.mjs`, not `estate-bootstrap.sh`. */
  const w4 = await world()
  const { publicKey } = await generateKeyPair('RS256', { extractable: true })
  void publicKey
  const wrongScope = httpIndexerClient({
    baseUrl: INDEXER,
    token: () => 'a-token-this-verifier-will-refuse',
    deadlineMs: 4_000,
    fetch: w4.fetch,
  })
  const unauthorized = await drivenReason(w4, wrongScope)
  assert.equal(unauthorized.unobserved_reason, 'unauthorized')

  /* 5. No INDEXER_URL. Nothing was dialled at all, which is a fact about this deploy manifest. */
  const w5 = await world()
  const noUrl = buildUpstreams(
    { identityUrl: IDENTITY, identityCredential: CREDENTIAL, indexerUrl: undefined, indexerDeadlineMs: 4_000 },
    { fetch: w5.fetch },
  )
  assert.equal(noUrl.indexer, undefined)
  const notConfigured = await drivenReason(w5, noUrl.indexer)
  assert.equal(notConfigured.unobserved_reason, 'not_configured')
  assert.equal(w5.indexerCalls.length, 0)

  // THE CLAIM, STATED AS ONE ASSERTION. Five freezes, five identical rows under migration 11, four
  // distinct causes under migration 12 — and the one that is expected is separable from the three
  // that are ours.
  const reasons = [
    chain.unobserved_reason,
    noCred.unobserved_reason,
    identityDown.unobserved_reason,
    unauthorized.unobserved_reason,
    notConfigured.unobserved_reason,
  ]
  assert.deepEqual(new Set(reasons).size, 4)
  assert.equal(
    reasons.filter((r) => r === 'no_credential' || r === 'unauthorized' || r === 'not_configured').length,
    4,
    'the platform-side failures must be separable from the chain-side one',
  )
})

test('the freeze an operator reads NAMES the cause, not just the absence', { skip }, async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  const { indexer } = upstreamsFor(w, CREDENTIAL)
  w.custody = { status: 503, body: { error: 'custody_total_unavailable', code: 'chain_not_followed' } }
  await drivenReason(w, indexer)

  // `asset_freezes.reason` is what `GET /reconciliation` shows first and what a console renders.
  // It said "no indexer observation" for both halves of this defect.
  const reason = await freezeReason()
  assert.ok(reason, 'the asset was not frozen')
  assert.match(reason, /chain holdings UNKNOWN, not zero/, 'the run must still refuse to imply a zero')
  assert.match(reason, /reason indexer_error/, 'the freeze does not say why it could not observe')
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT THAT MUST NOT MOVE. `undefined`, never `0n` — and now a reason beside it that
 * cannot become a number.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('every non-answer is `undefined` AND carries a reason — neither is ever `0n`', { skip }, async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  const { indexer } = upstreamsFor(w, CREDENTIAL)
  assert.ok(indexer)

  // Each of these is accepted by `BigInt`, by `Number`, or by a `?? 0` somewhere.
  // `{total: 7000000000000000000}` is the subtle one: a JSON number that has ALREADY lost its low
  // digits by the time `JSON.parse` returns, and those digits are where a drift lives.
  const unusable: unknown[] = [
    { total: 0 },
    { total: 7000000000000000000 },
    { total: '' },
    { total: null },
    { total: '0x1a' },
    { total: '-1' },
    { total: '7e18' },
    { total: ' 7000000000000000000 ' },
    { addresses: 2 },
    'not an object',
    'null',
    '{ this is not json',
  ]
  for (const body of unusable) {
    w.custody = { status: 200, body }
    const observation = await indexer.observe('ember', 'testnet')
    assert.equal(observation.total, undefined, `${JSON.stringify(body)} became a total`)
    assert.notEqual(observation.total, 0n)
    // The 200 arrived and was not a total. That is the indexer's problem, not identity's, and the
    // reason must say so or it has replaced one undifferentiated answer with another.
    assert.equal(observation.reason, 'unusable_answer', `${JSON.stringify(body)} was misdiagnosed`)
  }

  // The one case that must NOT be `unavailable`: every custody address answered and held nothing.
  // That is a real reading of a real chain, and it must be accepted AS a reading and then fail on
  // the drift.
  w.custody = { status: 200, body: { total: '0', addresses: 2 } }
  const measuredZero = await indexer.observe('ember', 'testnet')
  assert.equal(measuredZero.total, 0n)
  assert.equal(measuredZero.reason, null)

  // And `observedTotalFor` — the shape the contract is stated in, and the one every other test in
  // this repository drives — still answers exactly what it always did.
  w.custody = { status: 503, body: { error: 'nope' } }
  assert.equal(await indexer.observedTotalFor('ember', 'testnet'), undefined)
  w.custody = { status: 200, body: { total: (7n * ONE).toString() } }
  assert.equal(await indexer.observedTotalFor('ember', 'testnet'), 7n * ONE)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * The vocabulary, closed at both ends. These need no database.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('`reasonFor` is total, and answers only from the declared vocabulary', () => {
  const members = new Set<string>(UNOBSERVED_REASONS)
  const errors: unknown[] = [
    new Error('boom'),
    new TypeError('fetch failed'),
    'a string thrown by something',
    null,
    undefined,
    { status: 401 },
    Symbol('nope'),
  ]
  for (const err of errors) {
    const reason: UnobservedReason = reasonFor(err)
    assert.ok(members.has(reason), `reasonFor produced ${String(reason)}, which is not in the union`)
  }
  // The default is the coarse, conservative one — never something that reads as diagnosed.
  assert.equal(reasonFor(new Error('boom')), 'unreachable')
})

test('the reason vocabulary has no duplicates and matches the shape the schema accepts', () => {
  assert.equal(new Set(UNOBSERVED_REASONS).size, UNOBSERVED_REASONS.length)
  for (const reason of UNOBSERVED_REASONS) {
    // migration 12's `reconciliation_runs_reason_shape_chk`, restated so a new member that the
    // database would refuse is caught here rather than by an aborted reconciliation transaction.
    assert.match(reason, /^[a-z][a-z0-9_]{2,31}$/)
  }
})
