/**
 * THE LOOP, WITH THIS SERVICE'S OWN JOB AT THE TOP OF IT.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## Why this file exists even though `indexer/src/chainbacking.test.ts` already passes 7/7
 *
 * That file proves the seam: a real chain, `micro-indexer`'s real aggregate, a real HTTP hop, a
 * reference client, and this service's real `reconcileAsset` against a real database with
 * migration 11's constraints live. What it cannot prove is the thing that was actually broken.
 * **The defect was never that `reconcileAsset` mishandled an observation — it was that nothing
 * ever handed it one.** `grep -rn indexerObservedTotal` over 58 repositories found it supplied in
 * exactly one place, and that place was a test. A test that obtains the reading itself and passes
 * it in is, structurally, the same artefact as the defect: a caller that exists only in a suite.
 *
 * So the subject here is `jobs.ts`'s `ledger.reconcile` handler, and nothing in this file calls
 * `observedTotalFor`, `httpIndexerClient` or `reconcileAsset`. It enqueues a job into a real
 * `jobs` table, ticks a real `JobRunner`, and then reads `reconciliation_runs` and `asset_freezes`
 * to find out what the handler did. If the call were deleted from `jobs.ts` every non-trivial
 * assertion below would fail — which is the property the previous suite could not have.
 *
 * ## Two upstreams, and both of them are real servers on real ports
 *
 *   * **`FIXTURE`** — an HTTP server that answers the custody route's shape, and misbehaves on
 *     demand. It is what makes the guard cases expressible: a 401, a 503 with a fault code, a body
 *     whose `total` is a JSON number, an empty string, a bare `0`, a socket that never answers.
 *     Several of those are states the real indexer will never produce ON PURPOSE — which is
 *     exactly why they must be tested against something that will, since the client's job is to
 *     survive an impostor on the far end of a URL as well as an honest peer.
 *
 *   * **`LIVE`** — `micro-indexer`'s real `createServer`, `rpcCustodyObserver` and `RpcPool`,
 *     against a deterministic JSON-RPC node on a real port, imported across the checkout. Gated on
 *     `INDEXER_TEST_DATABASE_URL` and an indexer checkout beside this one; skipped, loudly, when
 *     either is absent. With it, the chain of custody from `eth_getBalance` to a row in
 *     `reconciliation_runs` contains no test double at all.
 *
 * ## Running it
 *
 *     LEDGER_TEST_DATABASE_URL=…                      # the guard cases
 *     LEDGER_TEST_DATABASE_URL=… INDEXER_TEST_DATABASE_URL=…   # and the live loop
 *
 * `scripts/verify-chain-backing.sh` provisions both databases and runs exactly this file.
 *
 * ## The specifier is COMPUTED, and that is not a style choice
 *
 * `typeof import('../../indexer/src/server.ts')` would be resolved by `tsc` even inside a dynamic
 * import, and `pnpm typecheck` runs inside this repository's Dockerfile, whose build context is
 * this repository plus two named contexts for `runtime` and `contracts`. A sibling service's
 * source is in none of them. The identical mistake failed `indexer-migrate` — the container the
 * whole estate's schema depends on — with eight `TS2307`s, and it was found by BUILDING the image,
 * not by typechecking locally. So the types this file knows about `micro-indexer` are declared
 * below by hand, and `indexerModule` proves each named export exists at run time, which turns a
 * drift into a message that names the export instead of `undefined is not a function`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type postgres from 'postgres'
import { JobQueue, JobRunner } from '@cloudsforge/jobs'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { httpIndexerClient, type IndexerClient } from './indexerclient.ts'
import { RECONCILE_KIND, registerHandlers, type JobDeps } from './jobs.ts'
import { postEntry } from './entries.ts'
import { requestFingerprint } from './idempotency.ts'
import {
  depositEntry,
  enabled,
  migrateTestDb,
  openDb,
  resetLedger,
  skip,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

/* ------------------------------------------------------------------ shared fixtures */

/** One EMBER, in wei. The unit the ledger reconciles in. */
const ONE = 1_000_000_000_000_000_000n

const TOKEN = 'a-service-token-that-is-long-enough'

let sql: postgres.Sql
const db = () => sql as unknown as Db

/**
 * Everything the handler needs except the indexer, which each case supplies.
 *
 * `assetTolerance` is empty on purpose. `withinTolerance` fails CLOSED on an asset it has no entry
 * for, so every non-zero drift below freezes — which is the behaviour under test, not a fixture
 * convenience.
 */
function jobDeps(indexer: IndexerClient | undefined): JobDeps {
  return {
    sql: db(),
    producer: 'ledger',
    logger: new Logger({ service: 'ledger-chainbacking', sink: () => {} }),
    metrics: new Metrics(),
    signingSecret: 'chainbacking-test-signing-secret-000',
    assetTolerance: {},
    reconcileAssets: ['EMBER'],
    reconcileNetwork: 'testnet',
    indexer,
    idempotencyTtlDays: 30,
  }
}

/** Credit EMBER into the custody asset account through the real posting path. */
async function credit(amount: bigint): Promise<void> {
  const request = depositEntry({ amount, assetCode: 'EMBER' })
  await postEntry({ sql: db(), producer: 'ledger' }, request, requestFingerprint(request))
}

/**
 * **The whole point of the file.** Enqueue the recurring job the deploy schedules every fifteen
 * minutes, and let a real `JobRunner` claim it `for update skip locked` and dispatch it into
 * `jobs.ts`. Nothing here calls the indexer or the reconciler; the handler does both or neither.
 *
 * `tick()` rather than `start()`: the runner exposes one poll precisely so a test drives it
 * deterministically instead of sleeping, and a sleep here would make the suite's duration a
 * property of the machine.
 */
async function runReconcileJob(
  indexer: IndexerClient | undefined,
  assetCode = 'EMBER',
): Promise<void> {
  const queue = new JobQueue(sql as never, { owner: 'chainbacking-test' })
  const runner = new JobRunner({ queue, concurrency: 1, pollMs: 10_000 })
  registerHandlers(runner, jobDeps(indexer))
  await queue.enqueue({
    kind: RECONCILE_KIND,
    key: `asset:${assetCode}`,
    payload: { assetCode, network: 'testnet' },
    onConflict: 'keep',
  })
  const claimed = await runner.tick()
  assert.equal(claimed, 1, 'the reconciliation job was not claimed — the runner ran nothing')
}

/** The row as the database actually holds it. The constraints are half of what is being proved. */
async function lastRun(): Promise<{
  observed_source: string
  unobserved_reason: string | null
  indexer_observed_total: string | null
  drift: string | null
  status: string
  chain: string
}> {
  const rows = await sql<
    {
      observed_source: string
      unobserved_reason: string | null
      indexer_observed_total: string | null
      drift: string | null
      status: string
      chain: string
    }[]
  >`
    select observed_source,
           unobserved_reason,
           indexer_observed_total::text as indexer_observed_total,
           drift::text as drift,
           status,
           chain
      from reconciliation_runs order by started_at desc, id desc limit 1
  `
  return rows[0]!
}

async function runCount(): Promise<number> {
  const rows = await sql<{ n: string }[]>`select count(*)::text as n from reconciliation_runs`
  return Number(rows[0]!.n)
}

async function frozen(assetCode = 'EMBER'): Promise<boolean> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from asset_freezes where asset_code = ${assetCode}
  `
  return rows[0]!.n !== '0'
}

/* ------------------------------------------------------------------ the fixture upstream */

/**
 * What the far end of `INDEXER_URL` will say. Every guard case is a mutation of this object rather
 * than a swapped-in stub, so the client and the handler under test are byte-identical in all of
 * them.
 */
interface Upstream {
  status: number
  /** Serialised verbatim, so a body that is not an object or not JSON is expressible. */
  body: unknown
  /** Answer nothing at all, so the DEADLINE is what ends the call. */
  stall: boolean
  /** Refuse without an `authorization` header, as the real route does. */
  requireToken: boolean
  requests: number
  authorizations: (string | null)[]
}

let upstream: Upstream
let fixture: Server
let fixtureBase: string

function startFixture(): Promise<void> {
  fixture = createHttpServer((req, res) => {
    upstream.requests += 1
    upstream.authorizations.push(req.headers['authorization'] ?? null)
    if (upstream.stall) return
    if (upstream.requireToken && !req.headers['authorization']) {
      const payload = JSON.stringify({ error: 'unauthorized' })
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(payload)
      return
    }
    const payload =
      typeof upstream.body === 'string' ? upstream.body : JSON.stringify(upstream.body)
    res.writeHead(upstream.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  return new Promise((resolve) => {
    fixture.listen(0, '127.0.0.1', () => {
      fixtureBase = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`
      resolve()
    })
  })
}

/**
 * The client the composition root builds, pointed at the fixture. Not a double.
 *
 * `null` rather than `undefined` for "no credential", because a default parameter is applied to an
 * explicitly-passed `undefined` too — so `fixtureClient(undefined)` would have quietly sent the
 * token and BREAK 3 would have asserted the wrong thing while passing. It did, until it did not.
 */
const fixtureClient = (token: string | null = TOKEN): IndexerClient =>
  httpIndexerClient({ baseUrl: fixtureBase, token: () => token ?? undefined, deadlineMs: 2_000 })

/* ------------------------------------------------------------------ the live upstream */

/**
 * `micro-indexer`'s own source, across the checkout, at RUN TIME ONLY. See the header on why the
 * specifier is computed rather than written as a literal.
 */
const INDEXER_SRC = new URL('../../indexer/src/', import.meta.url)

const liveEnabled =
  enabled &&
  Boolean(process.env['INDEXER_TEST_DATABASE_URL']) &&
  /test/i.test(process.env['INDEXER_TEST_DATABASE_URL'] ?? '') &&
  existsSync(fileURLToPath(new URL('server.ts', INDEXER_SRC)))

const liveSkip = liveEnabled
  ? false
  : 'set INDEXER_TEST_DATABASE_URL (name must contain "test") with a micro-indexer checkout beside this one'

/** Exactly the surface this file drives. Nothing is inferred; `indexerModule` asserts all of it. */
interface IndexerServerModule {
  createServer(deps: Record<string, unknown>): Server
}
interface IndexerCustodyModule {
  rpcCustodyObserver(deps: Record<string, unknown>): unknown
}
interface IndexerRpcModule {
  RpcPool: new (options: Record<string, unknown>) => unknown
}
interface IndexerStoreModule {
  upsertBlock(sql: unknown, scope: unknown, block: Record<string, unknown>): Promise<unknown>
  setCheckpoint(sql: unknown, scope: unknown, stream: string, height: number, hash: string): Promise<unknown>
  watchAddress(sql: unknown, scope: unknown, address: string, label: string): Promise<unknown>
}
interface IndexerMigrationsModule {
  MIGRATIONS: readonly unknown[]
  CHAIN_TABLES: readonly string[]
}
interface IndexerMetricsModule {
  registerServiceMetrics(metrics: unknown): unknown
}

/**
 * `micro-indexer`'s OWN `@cloudsforge/auth`, and the reason it cannot be this repository's.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `statusFor` — the one function in the estate that decides what an auth failure means — is written
 * as `err instanceof TokenError`, which is correct inside a container, where the service and the
 * package it authenticates with are one module graph. **This file is not inside that container.**
 * It runs `micro-ledger`'s tests and dynamically imports `micro-indexer`'s source from a sibling
 * checkout, and pnpm has materialised `@cloudsforge/auth` — a `file:` dependency on
 * `runtime/packages/auth` — into each checkout's own store as a separate physical copy. Two paths,
 * two evaluations, two `TokenError` classes that are structurally identical and `instanceof`-blind
 * to one another.
 *
 * So a stub verifier throwing THIS repository's `TokenError` produced 500 at the indexer's route,
 * not 401: `statusFor` returned `null`, the error fell through to the generic handler, and the run
 * recorded `indexer_error` — a fact about a cross-checkout module identity, dressed as a fact about
 * the indexer. The test that asserted `unauthorized` had never passed on a developer's machine, and
 * could not: it was skipped in CI, where `INDEXER_TEST_DATABASE_URL` is unset. micro-org#255.
 *
 * Resolving the specifier from the indexer's own root gives the class its `statusFor` will
 * recognise. Nothing about the product changes; this is the harness paying the cost of testing
 * across two checkouts rather than hiding it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function indexerTokenError(): Promise<new (message: string, reason: string) => Error> {
  const require = createRequire(fileURLToPath(new URL('server.ts', INDEXER_SRC)))
  const auth = (await import(pathToFileURL(require.resolve('@cloudsforge/auth')).href)) as {
    TokenError?: new (message: string, reason: string) => Error
  }
  if (auth.TokenError === undefined) {
    throw new Error("micro-indexer's @cloudsforge/auth no longer exports TokenError")
  }
  return auth.TokenError
}

async function indexerModule<T>(file: string, exports: readonly string[]): Promise<T> {
  const loaded = (await import(new URL(file, INDEXER_SRC).href)) as Record<string, unknown>
  for (const name of exports) {
    if (loaded[name] === undefined) {
      throw new Error(`micro-indexer's ${file} no longer exports ${name}`)
    }
  }
  return loaded as T
}

const SCOPE = { chain: 'ember', network: 'testnet' } as const
const CONFIRMATIONS = 60
const HEAD = 100
const CUSTODY_ADDRESSES = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]
const hashAt = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`

interface NodeState {
  balances: Map<string, bigint>
  refuse: Set<string>
}

let node: NodeState
let rpcServer: Server
let liveServer: Server
let liveBase: string
let indexerSql: postgres.Sql
let indexerTables: readonly string[] = []

/** A deterministic EVM chain. Synthetic, and said so: Hearth's mainnet has not launched. */
function startNode(): Promise<string> {
  rpcServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: unknown
        method: string
        params?: unknown[]
      }
      const send = (result: unknown, error?: unknown): void => {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          ...(error ? { error } : { result }),
        })
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        })
        res.end(payload)
      }
      if (body.method === 'eth_chainId') return send('0x1cf4')
      if (body.method === 'eth_getBlockByNumber') {
        const height = Number(String(body.params?.[0] ?? '0x0'))
        return send(
          height >= 0 && height <= HEAD
            ? { hash: hashAt(height), number: String(body.params?.[0]) }
            : null,
        )
      }
      if (body.method === 'eth_getBalance') {
        const address = String(body.params?.[0] ?? '').toLowerCase()
        if (node.refuse.has(address)) {
          return send(undefined, { code: -32000, message: 'missing trie node' })
        }
        return send(`0x${(node.balances.get(address) ?? 0n).toString(16)}`)
      }
      return send(undefined, { code: -32601, message: `unexpected ${body.method}` })
    })
  })
  return new Promise((resolve) => {
    rpcServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`)
    })
  })
}

async function startLiveIndexer(): Promise<void> {
  const TokenErrorClass = await indexerTokenError()
  const server = await indexerModule<IndexerServerModule>('server.ts', ['createServer'])
  const custody = await indexerModule<IndexerCustodyModule>('custody.ts', ['rpcCustodyObserver'])
  const rpc = await indexerModule<IndexerRpcModule>('rpc.ts', ['RpcPool'])
  const store = await indexerModule<IndexerStoreModule>('store.ts', [
    'upsertBlock',
    'setCheckpoint',
    'watchAddress',
    'TIP_STREAM',
  ])
  const migrations = await indexerModule<IndexerMigrationsModule>('migrations.ts', [
    'MIGRATIONS',
    'CHAIN_TABLES',
  ])
  const serviceMetrics = await indexerModule<IndexerMetricsModule>('metrics.ts', [
    'registerServiceMetrics',
  ])
  const { Lifecycle } = await import('@cloudsforge/lifecycle')
  const { registerHttpMetrics } = await import('@cloudsforge/telemetry')
  const postgresDriver = (await import('postgres')).default
  const { migrate } = await import('@cloudsforge/db')

  indexerSql = postgresDriver(process.env['INDEXER_TEST_DATABASE_URL']!, {
    max: 4,
    onnotice: () => {},
  })
  await migrate(indexerSql as never, migrations.MIGRATIONS as never, {
    service: 'ledger-chainbacking-test',
  })
  indexerTables = migrations.CHAIN_TABLES

  const rpcUrl = await startNode()
  node = { balances: new Map(), refuse: new Set() }

  const pool = new rpc.RpcPool({
    scope: SCOPE,
    endpoints: [{ name: 'fake-hearth', url: rpcUrl }],
    deadlineMs: 4_000,
  })
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
  liveServer = server.createServer({
    lifecycle,
    logger: new Logger({ service: 'indexer-live', sink: () => {} }),
    metrics: serviceMetrics.registerServiceMetrics(registerHttpMetrics(new Metrics())),
    // The JWKS path is `indexer/src/server.test.ts`'s subject, against the real `Verifier` and its
    // real error types. Stubbed here so this file tests the seam it is named for — but the SCOPE
    // is real: a principal without `indexer:read` is refused by the route's own `authorise`.
    verifier: {
      async principal(token: string) {
        if (token === TOKEN) return { kind: 'service', service: 'ledger', scopes: ['indexer:read'] }
        // **A `TokenError`, not a bare `Error`, and the indexer's own — see `indexerTokenError`.**
        // The route maps a rejected token to 401 and a verifier that BLEW UP to 503, which are two
        // different facts: one about the caller's credential, one about identity being down. A stub
        // throwing anything `statusFor` does not recognise produces the second, and the 401 case
        // below then asserts against a 500. The real `Verifier` throws this for an unverifiable
        // token; `indexer/src/server.test.ts` drives the same seam against the real one.
        throw new TokenErrorClass('unknown token', 'invalid')
      },
    },
    reads: new Proxy({}, { get: () => () => { throw new Error('custody route only') } }),
    tokens: { observe() { throw new Error('custody route only') } },
    custody: custody.rpcCustodyObserver({
      sql: indexerSql,
      callers: new Map([[`${SCOPE.chain}:${SCOPE.network}`, pool]]),
      labelPrefixes: ['deposit:', 'treasury:'],
      maxAddresses: 100,
      concurrency: 4,
    }),
  })
  await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', () => resolve()))
  liveBase = `http://127.0.0.1:${(liveServer.address() as AddressInfo).port}`
  lifecycle.markReady()

  // Kept out of `beforeEach`: the chain is the same in every live case, and rewriting a hundred
  // blocks per test would make the suite's cost a function of its length for no assertion's sake.
  for (let height = 0; height <= HEAD; height += 1) {
    await store.upsertBlock(indexerSql, SCOPE, {
      height,
      hash: hashAt(height),
      parentHash: height === 0 ? hashAt(0) : hashAt(height - 1),
      blockTime: new Date(1_700_000_000_000 + height * 15_000),
      txCount: 0,
      detail: {},
    })
  }
  await store.setCheckpoint(indexerSql, SCOPE, 'tip', HEAD, hashAt(HEAD))
  for (const [index, address] of CUSTODY_ADDRESSES.entries()) {
    await store.watchAddress(indexerSql, SCOPE, address, `deposit:u-${index}`)
  }
}

const liveClient = (token: string | undefined = TOKEN): IndexerClient =>
  httpIndexerClient({ baseUrl: liveBase, token: () => token, deadlineMs: 5_000 })

/* ------------------------------------------------------------------ lifecycle */

before(async () => {
  if (!enabled) return
  sql = openDb(4)
  await migrateTestDb(sql)
  await startFixture()
  if (liveEnabled) await startLiveIndexer()
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => fixture.close(() => resolve()))
  if (liveEnabled) {
    await new Promise<void>((resolve) => liveServer.close(() => resolve()))
    await new Promise<void>((resolve) => rpcServer.close(() => resolve()))
    await indexerSql.end({ timeout: 5 })
  }
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetLedger(sql)
  upstream = {
    status: 200,
    body: { total: (7n * ONE).toString(), addresses: 2 },
    stall: false,
    requireToken: true,
    requests: 0,
    authorizations: [],
  }
  if (liveEnabled) {
    for (const table of indexerTables) {
      if (table === 'watched_addresses' || table === 'blocks' || table === 'checkpoints') continue
      await indexerSql.unsafe(`truncate table ${table} cascade`)
    }
    node.balances.clear()
    node.refuse.clear()
  }
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CLAIM THIS FILE EXISTS TO MAKE
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test(
  "THE JOB MAKES THE CALL: a scheduled reconciliation obtains a chain reading and records `indexer`",
  { skip },
  async () => {
    await credit(7n * ONE)

    await runReconcileJob(fixtureClient())

    // The handler called the indexer. Before this commit this number was zero, for the life of the
    // service, in every environment.
    assert.equal(upstream.requests, 1, 'jobs.ts did not call the indexer')
    assert.equal(upstream.authorizations[0], `Bearer ${TOKEN}`)

    const row = await lastRun()
    // NOT `liability_sum`. That branch compared this ledger against this ledger and was the only
    // branch any production run had ever taken.
    assert.equal(row.observed_source, 'indexer')
    assert.equal(row.indexer_observed_total, (7n * ONE).toString())
    assert.equal(row.drift, '0')
    assert.equal(row.status, 'clean')
    // The chain NAME, from `contracts-chain`, not the URL slug the indexer was asked with. Two
    // different vocabularies for one asset, and the run row records the one an operator reads.
    assert.equal(row.chain, 'Hearth')
    assert.equal(await frozen(), false)
  },
)

test('a drift the chain can see freezes withdrawals, from the job rather than from a harness', { skip }, async () => {
  // `convertCoinToEmber` in its observable form: the ledger believes it holds coin the chain does
  // not show. Under `liability_sum` this reported clean for ever, because a fabricated deposit
  // moves both of the ledger's own sides at once.
  upstream.body = { total: (4n * ONE).toString(), addresses: 2 }
  await credit(7n * ONE)

  await runReconcileJob(fixtureClient())

  const row = await lastRun()
  assert.equal(row.observed_source, 'indexer')
  assert.equal(row.drift, (3n * ONE).toString())
  assert.equal(row.status, 'drift_exceeded')
  assert.equal(await frozen(), true)
})

test('SHARD has no chain, so the job asks nobody and records liability_sum', { skip }, async () => {
  // The mistake this guards is `isChainAsset` from contracts-money, which is TRUE of SHARD because
  // SHARD is in `CHAINS` "so the record is total". Using it would send the job to
  // `/v1/custody/shard/testnet/total`, a slug the indexer refuses by design, and the refusal would
  // freeze an asset that has no chain to be backed by.
  await runReconcileJob(fixtureClient(), 'SHARD')

  assert.equal(upstream.requests, 0, 'the job asked the indexer about an asset with no chain')
  const row = await lastRun()
  assert.equal(row.observed_source, 'liability_sum')
  assert.equal(row.chain, 'platform')
  assert.equal(row.status, 'clean')
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BREAKING EACH GUARD. Every case below must produce an UNOBSERVED, FAILED run — never a clean one
 * and never an observed zero.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * What every break must be true of, asserted in one place so no case can quietly assert less.
 *
 * `expected` is the `unobserved_reason` migration 12 requires. It is a REQUIRED parameter rather
 * than an optional one on purpose: every break below asserted the same four columns, which is
 * exactly how a 401 from an expired credential and a 503 from an unfollowed chain came to be the
 * same row for the life of the service. A helper that let a case skip the reason would let that
 * back in one case at a time.
 */
async function assertUnobservedFailure(expected: string): Promise<void> {
  const row = await lastRun()
  assert.equal(row.observed_source, 'unavailable', 'an unobservable indexer produced an observation')
  assert.equal(row.status, 'failed')
  // NULL, not 0, in both columns migration 11 constrains. A zero here would be a measurement.
  assert.equal(row.indexer_observed_total, null)
  assert.equal(row.drift, null)
  assert.equal(row.unobserved_reason, expected, 'the run did not record WHY it could not observe')
  assert.equal(await frozen(), true)
}

test('BREAK 1 — an unreachable indexer freezes the asset; the job never sees a 0n', { skip }, async () => {
  await credit(7n * ONE)
  // A port nothing listens on. If the client returned `0n` the ledger would record an observation
  // of an empty chain and a drift of the entire custody position — a fabricated number produced by
  // a network fault, and one that looks exactly like insolvency.
  const dead = httpIndexerClient({
    baseUrl: 'http://127.0.0.1:1',
    token: () => TOKEN,
    deadlineMs: 1_000,
  })
  await runReconcileJob(dead)
  // `unreachable`, not `indexer_error`: nothing on the far end answered at all. Migration 12 makes
  // the run say which, so this freeze is not confused with the estate's honest `chain_not_followed`.
  await assertUnobservedFailure('unreachable')
})

test('BREAK 2 — a stalled indexer ends at the DEADLINE and does not hold the job lease open', { skip }, async () => {
  await credit(7n * ONE)
  upstream.stall = true
  const startedAt = Date.now()
  await runReconcileJob(
    httpIndexerClient({ baseUrl: fixtureBase, token: () => TOKEN, deadlineMs: 250 }),
  )
  const elapsed = Date.now() - startedAt
  await assertUnobservedFailure('timeout')
  // The ceiling is real and it is absolute, not per-attempt. Without one, a provider holding the
  // socket open holds this asset's lease with it and the next sweep cannot be claimed.
  assert.ok(elapsed < 5_000, `the deadline did not bound the call (${elapsed}ms)`)
  // And it did not retry: a retry inside a leased handler spends the lease on an outage.
  assert.equal(upstream.requests, 1)
})

test('BREAK 3 — no credential is a 401, which is a freeze and never a number', { skip }, async () => {
  await credit(7n * ONE)
  // The state this deployment is in until `derive-grants.mjs` has read `INDEXER_SCOPES` and
  // micro-deploy has regenerated `IDENTITY_SERVICE_TOKEN_GRANTS`. A deploy mistake must stop
  // withdrawals, not report a total.
  await runReconcileJob(fixtureClient(null))
  assert.equal(upstream.requests, 1)
  assert.equal(upstream.authorizations[0], null)
  // `unauthorized` — the indexer refused what was presented, which is a GRANT problem. It is a
  // different row from `no_credential`, which is what `upstreams.ts` records when this container
  // holds no credential at all and the call is therefore never sent. Those have different remedies
  // (`derive-grants.mjs` against `estate-bootstrap.sh`) and, until migration 12, one row.
  await assertUnobservedFailure('unauthorized')
})

test('BREAK 4 — a 503 with a fault code is a refusal, not a fallback signal', { skip }, async () => {
  await credit(7n * ONE)
  // `chain_not_followed` is what the estate's own indexer answers today, because Hearth has not
  // launched. It is the honest answer and it must freeze.
  upstream.status = 503
  upstream.body = { error: 'custody_total_unavailable', code: 'chain_not_followed' }
  await runReconcileJob(fixtureClient())
  // **THE EXPECTED FREEZE.** This is the one an operator must be able to leave alone, and every
  // other break in this file must be distinguishable from it.
  await assertUnobservedFailure('indexer_error')
})

test('BREAK 5 — a 200 whose body is not a total, in every shape that would nearly parse', { skip }, async () => {
  // Each of these is accepted by `BigInt`, by `Number`, or by a `?? 0` somewhere, and each would
  // have become an observation. `{total: 7000000000000000000}` is the subtle one: a JSON number
  // that has ALREADY lost its low digits by the time `JSON.parse` returns, and the low digits of
  // an 18-decimal balance are exactly where a drift lives.
  const bodies: unknown[] = [
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
  for (const body of bodies) {
    await resetLedger(sql)
    await credit(7n * ONE)
    upstream.status = 200
    upstream.body = body
    await runReconcileJob(fixtureClient())
    const row = await lastRun()
    assert.equal(
      row.observed_source,
      'unavailable',
      `${JSON.stringify(body)} became an observation`,
    )
    assert.equal(row.indexer_observed_total, null, `${JSON.stringify(body)} became a total`)
    assert.equal(row.status, 'failed')
    // A 200 that is not a total is the INDEXER's problem — a version skew, or something that is not
    // the indexer on the far end of that URL. It must not be reported as an authentication fault.
    assert.equal(row.unobserved_reason, 'unusable_answer', `${JSON.stringify(body)} was misdiagnosed`)
  }
})

test('BREAK 6 — a MEASURED zero is an observation, and it fails LOUDLY rather than passing quietly', { skip }, async () => {
  // The distinction the whole release turns on, and the one case above that must NOT be
  // `unavailable`. Every custody address answered and every one held nothing: that is a real
  // reading of a real chain, the ledger must accept it AS a reading, and then fail on it, because
  // the ledger claims seven EMBER the chain does not show.
  upstream.body = { total: '0', addresses: 2 }
  await credit(7n * ONE)

  await runReconcileJob(fixtureClient())

  const row = await lastRun()
  assert.equal(row.observed_source, 'indexer')
  assert.equal(row.indexer_observed_total, '0')
  assert.equal(row.drift, (7n * ONE).toString())
  assert.equal(row.status, 'drift_exceeded')
  assert.equal(await frozen(), true)
  // An operator tells this apart from BREAK 1 at a glance: an observed zero and a drift, against
  // two NULLs. Those are different mornings and the schema keeps them different.
  assert.notEqual(row.drift, null)
})

test('BREAK 7 — an unobserved run can never LIFT a freeze a real observation set', { skip }, async () => {
  // The half of the original defect that did the damage. `clean` lifts a freeze, and a vacuous run
  // could always be clean, so the check that could not fail outranked the one that could.
  upstream.body = { total: (4n * ONE).toString(), addresses: 2 }
  await credit(7n * ONE)
  await runReconcileJob(fixtureClient())
  assert.equal(await frozen(), true)

  // Now the indexer goes dark. The freeze must survive it.
  upstream.status = 503
  upstream.body = { error: 'custody_total_unavailable', code: 'rpc_unavailable' }
  await runReconcileJob(fixtureClient())
  assert.equal(await frozen(), true, 'an unobserved run lifted a freeze')
  assert.equal((await lastRun()).status, 'failed')

  // Only an exactly-clean OBSERVED run lifts it.
  upstream.status = 200
  upstream.body = { total: (7n * ONE).toString(), addresses: 2 }
  await runReconcileJob(fixtureClient())
  assert.equal((await lastRun()).observed_source, 'indexer')
  assert.equal((await lastRun()).status, 'clean')
  assert.equal(await frozen(), false)
})

test('BREAK 8 — a deployment with no INDEXER_URL freezes rather than falling back', { skip }, async () => {
  await credit(7n * ONE)
  // `deps.indexer` is `undefined`, which is what `index.ts` builds when the variable is unset. The
  // optional chain in the handler must not become an absence that reads as "check not required".
  await runReconcileJob(undefined)
  await assertUnobservedFailure('not_configured')
  assert.equal(await runCount(), 1)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LIVE LOOP: no test double anywhere between `eth_getBalance` and `reconciliation_runs`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('LIVE — the job, the real indexer, and a real chain read at the confirmed depth', { skip: liveSkip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[1]!, 3n * ONE)
  await credit(7n * ONE)

  await runReconcileJob(liveClient())

  const row = await lastRun()
  assert.equal(row.observed_source, 'indexer')
  assert.equal(row.indexer_observed_total, (7n * ONE).toString())
  assert.equal(row.status, 'clean')
  assert.equal(row.drift, '0')
  assert.equal(await frozen(), false)
})

test('LIVE — one unreadable address withholds the whole total, and the job records unknown', { skip: liveSkip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[1]!, 3n * ONE)
  node.refuse.add(CUSTODY_ADDRESSES[1]!)
  await credit(7n * ONE)

  await runReconcileJob(liveClient())

  // The tempting answer was 4 EMBER — the address that answered. It is low, low is positive drift,
  // and positive drift freezes on the strength of one RPC failure while asserting a number that
  // was never true. The indexer refuses; the ledger records that nobody looked, and that the
  // refusal came from the INDEXER rather than from this service's credentials.
  await assertUnobservedFailure('indexer_error')
})

test('LIVE — a token without indexer:read is a 401, and the whole loop fails closed on it', { skip: liveSkip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 7n * ONE)
  await credit(7n * ONE)

  await runReconcileJob(liveClient('not-the-service-token'))

  await assertUnobservedFailure('unauthorized')
})

test('LIVE — the confirmed depth is real: a balance is read below the head, not at it', { skip: liveSkip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 7n * ONE)
  await credit(7n * ONE)

  await runReconcileJob(liveClient())

  // The height every balance was read at, straight off the observation the real observer produced.
  // Reading at the head would let a reorg-eligible block become a drift, and a drift freezes.
  const total = await fetch(`${liveBase}/v1/custody/ember/testnet/total`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const observation = (await total.json()) as { observedAtBlock: number; requiredConfirmations: number }
  assert.equal(observation.requiredConfirmations, CONFIRMATIONS)
  assert.equal(observation.observedAtBlock, HEAD - CONFIRMATIONS + 1)
  assert.equal((await lastRun()).observed_source, 'indexer')
})

test('LIVE — the freeze names WHERE the observed side sits, end to end', { skip: liveSkip }, async () => {
  // Step 5 of micro-org#248, through every real component in the loop: the indexer's own
  // `groupByPrefix` splits the set it summed, the route serialises it, `breakdownFrom` renders it
  // to prose, and `reconcileAsset` writes it into the column an operator reads first. Nothing here
  // is a double, which is what makes it evidence rather than agreement between two fixtures.
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[1]!, 3n * ONE)
  await credit(10n * ONE)

  await runReconcileJob(liveClient())

  const row = await lastRun()
  assert.equal(row.status, 'drift_exceeded')
  assert.equal(row.drift, (3n * ONE).toString())

  // Both live custody addresses carry `deposit:` labels, so the drift is entirely in deposits and
  // the treasury bucket is a reported zero rather than an absent one. An operator reading this
  // knows which of two services to look at before they open a second window.
  const [freeze] = await sql<{ reason: string }[]>`
    select reason from asset_freezes where asset_code = 'EMBER'
  `
  assert.equal(
    freeze?.reason,
    'reconciliation drift_exceeded: drift 3000000000000000000 ' +
      '(custody 10000000000000000000, observed 7000000000000000000 = ' +
      'deposit: 7000000000000000000 over 2 addresses, treasury: 0 over 0 addresses)',
  )
})
