/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step below carries the reason it must precede the next; the ordering is the substance of
 * this file, and getting it wrong reproduces a defect the estate already has.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7 — and it matters more here than anywhere: the
 * ledger's migrations create the constraint triggers that are the service's entire safety
 * argument, and a service that could create them at boot is a service that could start without
 * them.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql , networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { indexerChainFor } from './indexerclient.ts'
import { buildUpstreams } from './upstreams.ts'
import { trialBalance } from './entries.ts'
import { listFreezes } from './reconcile.ts'
import type { Db } from './outbox.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

// 3. The database pool. Opened before the schema assertion because the assertion is a query, and
//    before the Lifecycle because the readiness probe closes over it.
const poolOptions = {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
}
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `LEDGER_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

// 4. Assert the schema. This does **not** migrate. For this service the assertion is load-bearing
//    in a way it is not elsewhere: below SCHEMA_VERSION the deferred balancing trigger and the
//    immutability triggers may not exist, and a replica serving POST /entries against a schema
//    without them would accept unbalanced entries silently and for ever. Refusing to start is the
//    only safe response.
try {
  // The runtime packages accept a narrow structural `Sql` rather than importing postgres.js, so
  // they stay testable and driver-swappable. The cast is the price of that.
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval, or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignored
      // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
      // database is not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(
    // Soft. If identity is down this service still serves everything that does not need a fresh
    // key — and marking it hard means one identity blip removes every service in the estate from
    // its balancer at once, which is a cascade, not a safety measure.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )

// 6. Routes. Constructed after the Lifecycle so the health handlers report real state, and after
//    the pool so the stores are real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
// ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
//
// The `networkSql` key below used to be the literal `mainnet`. Same image, same code,
// different env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and
// then refused every request the gateway stamped `CF-Network: testnet`, because it genuinely
// held no handle by that name. Five services crash-looped on it within ten minutes of the
// first deploy: the refusal was right, the registration was wrong.
//
// `CF_NETWORK_SINGLE` is how a single-network pod says which estate it is. The render sets it
// for every deployment; `mainnet` remains the default only for a bare `pnpm dev`.
const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  sql: networkSql({
    [ownNetwork]: sql as unknown as RuntimeSql,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  }),
  // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
  // call, because those go container to container and never reach the gateway that stamps one.
  // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
  // request; it only answers the internal callers that never had one.
  singleNetwork: ownNetwork,
  producer: SERVICE,
  // Sampled at scrape time rather than on a timer. There is no `setInterval` in this repository
  // and CI greps for one — rule 8. A scrape is already periodic, so the scrape is when to sample.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)

    // The one gauge that must read zero. Sampled here rather than only on a request to
    // /trial-balance, so that an unscraped, unqueried ledger still reports it.
    const balance = await trialBalance(sql as unknown as Db)
    metrics.set('ledger_trial_balance_delta', Number(balance.totalAbsoluteDelta))
    if (!balance.balanced) {
      logger.fatal('TRIAL BALANCE IS NOT ZERO', { totalAbsoluteDelta: balance.totalAbsoluteDelta })
    }

    metrics.set('ledger_assets_frozen', (await listFreezes(sql as unknown as Db)).length)

    // **Whether this process could authenticate to the indexer RIGHT NOW**, which is the question
    // that had no answer anywhere in the estate while the ten-minute token was quietly dying inside
    // a fifteen-minute job. Sampled from what the provider holds rather than by dialling identity:
    // a probe that dialled would multiply the estate's readiness traffic by its replica count into
    // the one service it can least afford to amplify a fault in, and would answer a question this
    // process can already answer from memory.
    //
    // 0 with no credential configured at all, so the series exists in that deployment too — an
    // absent metric is indistinguishable from a scrape that failed, and this is the one condition
    // that must not be silent.
    metrics.set('ledger_service_token_usable', identityTokens?.snapshot().hasUsableToken ? 1 : 0)
  },
})

// 6b. The chain half of the solvency invariant.
//
//     ══════════════════════════════════════════════════════════════════════════════════════════
//     **AN ABSENT INDEXER IS NOT A DISABLED CHECK, IT IS A FAILING ONE**, and this is the only
//     place in the process that can say so before the first sweep does it fifteen minutes later.
//     Without a client every `ON_CHAIN_ASSETS` member records `unavailable` / `failed` and freezes
//     withdrawals; the variable is optional only because `migrator.ts` shares this environment and
//     `ledger-migrate` is given no indexer (see `env.ts` on `indexerUrl`).
//
//     So the condition is logged at boot, at the level its consequence deserves, naming the assets
//     it will freeze. A configuration whose effect is "this platform stops paying people" must not
//     be discoverable only by noticing an absence.
//     ══════════════════════════════════════════════════════════════════════════════════════════
//     ══════════════════════════════════════════════════════════════════════════════════════════
//     **AND THE CREDENTIAL IS EXCHANGED, NOT READ ONCE.** The line that used to be here was
//
//         token: () => env.indexerToken
//
//     — a function called per request, "so a future short-TTL credential needs no change here",
//     returning a string read once at import from a token that expires in 600 seconds. This job
//     runs every 900. So the chain-backing call authenticated once per bootstrap and never again,
//     and every sweep after minute ten froze EMBER on an expired credential while writing exactly
//     the row an honest "the chain could not be observed" failure writes.
//
//     The seam was right and the body was wrong, which is why the body now lives in
//     `upstreams.ts` — a module a test can import without starting a server. That file carries the
//     argument; this line is one call, deliberately.
//     ══════════════════════════════════════════════════════════════════════════════════════════
const chainBackedAssets = env.reconcileAssets.filter((asset) => indexerChainFor(asset) !== undefined)
const { identityTokens, indexer } = buildUpstreams(env, {
  onEvent: (event) => {
    metrics.increment('ledger_service_token_events_total', { kind: event.kind })
    if (event.kind === 'minted') {
      logger.info('minted a service token from the credential', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else if (event.kind === 'exchange_failed') {
      // `warn`, not `fatal`, and only because of `hadUsableToken`: a failed exchange while a live
      // token is still held is the outage this provider is built to ride out, and paging on it
      // would page on every identity blip. The consequence, if it persists, arrives on its own as
      // a frozen asset whose run row says `no_credential`.
      logger.warn('service credential exchange failed', { ...event })
    }
  },
  onResult: (event) => {
    metrics.increment('ledger_indexer_calls_total', { outcome: event.outcome })
    metrics.observe('ledger_indexer_duration_ms', event.durationMs)
  },
})

if (!indexer && chainBackedAssets.length > 0) {
  logger.fatal('NO INDEXER CONFIGURED — every chain-backed asset will freeze on its first sweep', {
    assets: chainBackedAssets,
    remedy: 'set INDEXER_URL, or remove these assets from LEDGER_RECONCILE_ASSETS deliberately',
  })
} else if (indexer && !identityTokens && chainBackedAssets.length > 0) {
  logger.fatal('NO IDENTITY CREDENTIAL — the custody total demands indexer:read, so every chain-backed asset will freeze', {
    assets: chainBackedAssets,
    remedy:
      'set LEDGER_IDENTITY_CREDENTIAL (long-lived, from POST /service-credentials); the grant is derived from INDEXER_SCOPES in src/indexerclient.ts',
    // Said out loud so the row an operator will find is the one they can search for.
    runsWillRecord: 'observed_source=unavailable, unobserved_reason=no_credential',
  })
}

// **The retired variable, detected only so that it can be complained about.** An operator who
// redeploys with `LEDGER_SERVICE_TOKEN` and not `LEDGER_IDENTITY_CREDENTIAL` gets a service that
// looks configured and is not — which is a quieter version of the defect the credential replaced,
// and the estate has seen four of these on running containers already. It is never presented: this
// is the only line in the service that reads it.
if (env.legacyServiceTokenPresent) {
  logger.error('LEDGER_SERVICE_TOKEN is set and is IGNORED', {
    why: 'it held a 600-second token read once at boot, and the reconciliation job runs every 900 seconds',
    remedy: 'remove it and set LEDGER_IDENTITY_CREDENTIAL, which is long-lived and is exchanged per token',
  })
}

// 7. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
const jobDeps: JobDeps = {
  sql: sql as unknown as Db,
  producer: SERVICE,
  logger,
  metrics,
  signingSecret: env.outboxSigningSecret,
  assetTolerance: env.assetTolerance,
  reconcileAssets: env.reconcileAssets,
  reconcileNetworks: env.reconcileNetworks,
  // The same two pools the HTTP side selects between, handed to the job runner as a map rather
  // than a selector: a job has no request to resolve a network from, it has a payload.
  reconcileSql: {
    [ownNetwork]: sql as unknown as Db,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as Db } : {}),
  },
  indexer,
  idempotencyTtlDays: env.idempotencyTtlDays,
}

const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const reschedule = rescheduleRecurring(queue, logger, jobDeps)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, jobDeps)
await seedRecurring(queue, jobDeps)
runner.start()

// 8. Listen. Last of the construction steps, because a socket that accepts before its dependencies
//    exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 9. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//    balancer is allowed to send traffic.
lifecycle.markReady()

// 10. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above.
//     Hooks run in reverse registration order, so the server closes first, then the runner stops
//     claiming and drains, then the pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
