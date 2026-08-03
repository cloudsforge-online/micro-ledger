/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and adding one fails review — the estate
 * runs eight of them today, each guarded only by a module-local boolean, which is a variable that
 * by construction cannot be seen by a second process.
 *
 * **The lease key names the contended resource, not the row.** This is the decision most likely to
 * be got wrong by someone extending this file, and it is where the correctness lives. Ask: what
 * would break if two of these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work                  | Key             | What two at once would break                        |
 *   |-----------------------|-----------------|-----------------------------------------------------|
 *   | outbox.relay          | `stream`        | The outbox stream. Two relays deliver one batch to   |
 *   |                       |                 | one subscriber twice.                                |
 *   | ledger.reconcile      | `asset:<code>`  | That asset's freeze row and its run history. Keyed   |
 *   |                       |                 | per asset because assets genuinely parallelise —     |
 *   |                       |                 | a global key would serialise EMBER behind BTC for no |
 *   |                       |                 | reason. Keyed on the RUN id instead would let two    |
 *   |                       |                 | runs of one asset race to set and clear its freeze,  |
 *   |                       |                 | and a freeze cleared by a stale run is a withdrawal  |
 *   |                       |                 | path reopened against drift that still exists.       |
 *   | ledger.balances.rebuild | `global`      | `balances_shadow`, which is one table for the whole  |
 *   |                       |                 | chart. Two rebuilds would interleave DELETE and      |
 *   |                       |                 | INSERT and report mismatches that are artefacts of   |
 *   |                       |                 | each other rather than of the ledger.                |
 *   | ledger.idempotency.reap | `global`      | Nothing, but two reapers is two long DELETEs         |
 *   |                       |                 | competing for the same row locks at the head of      |
 *   |                       |                 | every posting request.                               |
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Metrics, Logger } from '@cloudsforge/telemetry'
import { type AssetTolerance, type LedgerAssetCode, isChainAsset } from '@cloudsforge/contracts-money'
// `chainSpec` is contracts-chain's, and contracts-money re-exports only the values it reuses. The
// chain's human name is a chain fact, so it is taken from the chain contract rather than restated.
import { chainSpec } from '@cloudsforge/contracts-chain'
import { rebuildBalances } from './balances.ts'
import { reconcileAsset } from './reconcile.ts'
import { indexerChainFor, type IndexerClient, type UnobservedReason } from './indexerclient.ts'
import { reapIdempotencyKeys } from './idempotency.ts'
import { createRelay, type RelayDeps, type Db } from './outbox.ts'

export const RELAY_KIND = 'outbox.relay'
export const RECONCILE_KIND = 'ledger.reconcile'
export const REBUILD_KIND = 'ledger.balances.rebuild'
export const REAP_KIND = 'ledger.idempotency.reap'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export interface JobDeps {
  readonly sql: Db
  /**
   * The service name stamped on every outbox row this job writes.
   *
   * Needed since reconciliation started announcing itself: `producer` is checked against the topic's
   * owner by `validateEnvelope`, so it is part of the envelope rather than a label.
   */
  readonly producer: string
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly assetTolerance: AssetTolerance
  readonly reconcileAssets: readonly LedgerAssetCode[]
  readonly reconcileNetwork: 'mainnet' | 'testnet'
  /**
   * Where a chain observation comes from, or `undefined` when this deployment has no indexer
   * configured.
   *
   * **`undefined` is not a disabled check, it is a failing one.** With no client, every chain asset
   * records `unavailable` / `failed` and freezes — see `env.ts` on `indexerUrl` for why the
   * variable is optional at all (`ledger-migrate` shares this environment and has no indexer), and
   * `index.ts` for the boot line that says so out loud. The only way to stop an asset being
   * checked is to remove it from `LEDGER_RECONCILE_ASSETS`, which is a visible decision in a
   * deploy manifest.
   */
  readonly indexer: IndexerClient | undefined
  readonly idempotencyTtlDays: number
}

export interface RecurringJob {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
  readonly payload?: Record<string, unknown>
}

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * plus the reschedule on completion — so the interval survives a restart, is visible in a table an
 * operator can query, and is claimed by exactly one replica.
 */
export function recurringJobs(deps: Pick<JobDeps, 'reconcileAssets' | 'reconcileNetwork'>): RecurringJob[] {
  return [
    { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },

    // Every fifteen minutes. Reconciliation is the only thing that catches a liability minted
    // against no custody position, and the window between runs is the window in which such a
    // liability is withdrawable. Fifteen minutes is short enough to bound that and long enough not
    // to sum the chart of accounts continuously.
    ...deps.reconcileAssets.map((assetCode) => ({
      kind: RECONCILE_KIND,
      key: `asset:${assetCode}`,
      everyMs: 15 * MINUTE,
      payload: { assetCode, network: deps.reconcileNetwork },
    })),

    // Nightly, per 04-domain-model.md §2.3. A full replay is the expensive check, so it runs on the
    // slowest cadence that still bounds how long a projection drift could go unnoticed.
    { kind: REBUILD_KIND, key: 'global', everyMs: 24 * HOUR },

    { kind: REAP_KIND, key: 'global', everyMs: 24 * HOUR },
  ]
}

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue, deps: JobDeps): Promise<void> {
  for (const job of recurringJobs(deps)) {
    await queue.enqueue({
      kind: job.kind,
      key: job.key,
      onConflict: 'keep',
      ...(job.payload ? { payload: job.payload } : {}),
    })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling
 * a job that has failed its full attempt budget hides a permanent fault behind a busy loop — and a
 * reconciliation job that fails permanently is a ledger that has stopped being checked.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  logger: Logger,
  deps: JobDeps,
): (event: RunnerEvent) => void {
  const byKey = new Map(recurringJobs(deps).map((job) => [`${job.kind}|${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind && event.key ? byKey.get(`${event.kind}|${event.key}`) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
        ...(recurring.payload ? { payload: recurring.payload } : {}),
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }))
  }
}

/**
 * Which chain a run is recorded against.
 *
 * `SHARD` and `USD` are platform units with no chain behind them, and a `TOKEN:` asset's chain is
 * a property of its deployment that this service does not hold. Recording `platform` is the honest
 * answer for all three; inventing a chain name would make a run look like an on-chain check it is
 * not.
 */
export function chainNameFor(assetCode: LedgerAssetCode): string {
  if (assetCode === 'SHARD' || !isChainAsset(assetCode)) return 'platform'
  return chainSpec(assetCode).name
}

/**
 * What to do about each way of failing to observe, put beside the log line that reports it.
 *
 * A `Record<UnobservedReason, string>` rather than a partial map or a `switch`: adding a ninth
 * reason to the union in `indexerclient.ts` without deciding what an operator should do about it is
 * then a compile error, which is the only mechanism that keeps a diagnosis from decaying back into
 * an undifferentiated string. It exists because the freeze it annotates is the estate's most
 * consequential one and, until this change, the least readable — the same three words whether the
 * chain had not launched or this service's own credential had expired.
 *
 * Deliberately generic advice, containing no URL and no value read from the environment: this is
 * interpolated into a log line that ships to the collector.
 */
const REMEDIES: Record<UnobservedReason, string> = {
  not_configured:
    'this deployment has no INDEXER_URL, so nothing was dialled — set it, or remove the asset from LEDGER_RECONCILE_ASSETS deliberately',
  no_credential:
    'THIS IS NOT THE CHAIN. ledger could not obtain a service token: LEDGER_IDENTITY_CREDENTIAL is unset, or identity refused the exchange, or identity is unreachable',
  unauthorized:
    'THIS IS NOT THE CHAIN. the indexer refused ledger token; check the indexer:read grant derived from INDEXER_SCOPES in src/indexerclient.ts',
  timeout:
    'the indexer did not answer within LEDGER_INDEXER_DEADLINE_MS; the chain reading itself may be slow rather than absent',
  unreachable:
    'no HTTP answer from the indexer at all — check it is up and that INDEXER_URL resolves from this container',
  indexer_error:
    'the indexer answered 5xx; its fault code is the diagnosis. `chain_not_followed` here is the EXPECTED state until Hearth launches',
  indexer_refused:
    'the indexer refused the request itself — an unknown chain slug or a network it does not carry',
  unusable_answer:
    'the indexer answered 200 with something that is not a decimal-string total; a version skew, or that URL is not the indexer',
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  /**
   * Reconciliation. Compares Σ custody assets against the other side of the invariant for one
   * asset, records the run, and freezes or unfreezes withdrawals accordingly.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THIS HANDLER IS WHERE THE INDEXER CALL IS MADE. IT IS THE CALL THAT WAS MISSING FOR THE LIFE
   * OF THE SERVICE**, and the two lines below are the whole of what was wrong with the estate's
   * solvency guarantee.
   *
   * `reconcileAsset` has always taken an optional `indexerObservedTotal`, and this call site never
   * once supplied one. `grep -rn indexerObservedTotal` over 58 repositories found it passed in
   * exactly one place: a test. So the ternary it fed silently selected
   * `observed_source = 'liability_sum'`, and the check guarding "every EMBER balance is backed by
   * real chain holdings" compared this ledger against this ledger — a check that could not fail, on
   * the one asset where failing is the point. Worse: `clean` is the status that LIFTS a freeze, and
   * a vacuous run could always be clean, so such a run would delete a freeze a real observation had
   * just written.
   *
   * ## What the call is, and the three things about it that are easy to get wrong
   *
   *   * **It is asked only of an asset that has a chain.** `isOnChainAsset` is `reconcile.ts`'s —
   *     `ON_CHAIN_ASSETS`, NOT contracts-money's `isChainAsset`, which is true of SHARD because
   *     SHARD is in `CHAINS` "so the record is total". Asking the indexer about Shards would
   *     request a slug it refuses by design, and the 404 would come back here as an unobservable
   *     asset and freeze something that has no chain to be backed by. For SHARD and USD, absence is
   *     correct and records `liability_sum` — a real check, and the only one those assets can have.
   *   * **The observation is obtained OUTSIDE the reconciliation transaction, and before it.**
   *     `reconcileAsset` opens one transaction so both ledger totals are read in a single snapshot;
   *     an HTTP call inside it would hold that snapshot open for the whole deadline, on the busiest
   *     tables in the estate. The reading is a fact about the chain a few hundred milliseconds ago
   *     either way — there is no snapshot that could make it simultaneous — so the honest structure
   *     is: observe, then reconcile against what was observed.
   *   * **The conditional spread, not `indexerObservedTotal: observed`.** `exactOptionalPropertyTypes`
   *     aside, an explicitly-present `undefined` and an absent key are the same to `reconcileAsset`;
   *     writing it this way makes the absence a decision at the call site rather than a value that
   *     happened to be undefined.
   *
   * ## The failure mode is the feature. Do not add a fallback.
   *
   * `observedTotalFor` returns `undefined` for every non-answer — a timeout, a refused connection,
   * a 401 from a missing grant, a 503 from a halted chain, a body that is not a decimal string, and
   * a `0` that arrived as a JSON number. Every one of those records `unavailable` / `failed`, which
   * freezes the asset and which no later unobserved run can lift. **The gap fails closed.** A
   * cached previous total, a retry loop, a `?? 0n`, or an `if (asset === 'EMBER')` would each turn
   * it back into a check that cannot fail. `indexerclient.ts` carries the argument in full.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  runner.register<{ assetCode?: string; network?: string }>(RECONCILE_KIND, async (job) => {
    const assetCode = job.payload.assetCode
    if (typeof assetCode !== 'string') {
      // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt budget
      // and dead-letters it, which is correct — retrying will not make the payload valid.
      throw new Error(`${RECONCILE_KIND} requires a string assetCode`)
    }
    const network = job.payload.network === 'mainnet' ? 'mainnet' : 'testnet'
    const asset = assetCode as LedgerAssetCode

    // `indexerChainFor` is derived from `ON_CHAIN_ASSETS`, which is the same list `reconcileAsset`
    // consults to decide that an unobserved asset is a failure rather than a `liability_sum`. That
    // the two agree is not left to inspection: `indexerclient.test.ts` asserts a slug exists for
    // exactly the assets `isOnChainAsset` accepts, so neither can drift into the other's blind
    // spot — an asset
    // this handler skips but `reconcileAsset` demands a reading for would freeze for ever with no
    // call ever having been attempted.
    const chainSlug = indexerChainFor(asset)
    /**
     * The observation, and — when there is none — why not.
     *
     * `observe` rather than `observedTotalFor`, and the difference is the second half of this
     * defect. The total alone made every failure identical: an expired token, an unlaunched chain,
     * a timeout and a 403 all arrived here as `undefined` and left as the same row. That mattered
     * because ledger's own credential was a 600-second token and this job runs every 900 seconds,
     * so the estate spent every deployment past minute ten writing "the chain could not be
     * observed" when the chain was fine and the token was dead. `indexerclient.ts` classifies;
     * nothing is inferred here.
     *
     * The two ways of not asking are separated rather than collapsed, and the separation is the
     * same discipline this whole change is about:
     *
     *   * **`chainSlug === undefined`** is SHARD or USD — assets with no chain. Nothing is asked
     *     because there is nothing to ask, `reconcileAsset` records `liability_sum`, and there is
     *     no absence to explain. Reporting `not_configured` here would be a lie that happens not to
     *     be read today, and the day it IS read is the day an on-chain asset is added without a
     *     slug and gets diagnosed as a deploy fault.
     *   * **`deps.indexer === undefined`** is a deployment with no `INDEXER_URL`. Nothing was
     *     dialled, and that IS a fact about this deploy manifest — `not_configured`.
     */
    const observation =
      chainSlug === undefined
        ? { total: undefined, reason: null }
        : deps.indexer === undefined
          ? { total: undefined, reason: 'not_configured' as const }
          : await deps.indexer.observe(chainSlug, network)

    const result = await reconcileAsset(deps.sql, {
      assetCode: asset,
      chain: chainNameFor(asset),
      network,
      tolerance: deps.assetTolerance,
      producer: deps.producer,
      // The conditional spread, not `indexerObservedTotal: observation.total`.
      // `exactOptionalPropertyTypes` aside, an explicitly-present `undefined` and an absent key are
      // the same to `reconcileAsset`; writing it this way makes the absence a decision at the call
      // site rather than a value that happened to be undefined.
      ...(observation.total === undefined
        ? { ...(observation.reason ? { unobservedReason: observation.reason } : {}) }
        : { indexerObservedTotal: observation.total }),
    })

    // **`Number(null)` is `0`.** This line read `Number(result.drift)` unconditionally, and now that
    // an unobserved run reports `drift: null` that would publish a drift of exactly zero — the most
    // reassuring number available — for the state in which nobody looked at the chain at all. The
    // drift gauge is written only when a drift was actually computed, and
    // `ledger_reconciliation_observed` is what tells a dashboard whether to believe it. A gauge
    // cannot express "unknown", so the honest design is a second series that says so.
    deps.metrics.set('ledger_reconciliation_observed', result.drift === null ? 0 : 1, { asset: assetCode })
    if (result.drift !== null) {
      deps.metrics.set('ledger_reconciliation_drift', Number(result.drift), { asset: assetCode })
    }
    // **Labelled by reason, so an alert can tell the two freezes apart without a human reading a
    // log.** `ledger_reconciliation_observed` going to 0 was the only signal, and it fired
    // identically for "Hearth has not launched" — which is expected and is argued for in `env.ts` —
    // and for "this service's token expired ten minutes into a fifteen-minute job", which is a
    // page. One series with a reason label is what lets the second one be alerted on and the first
    // one not be. Written only when there IS a reason: a gauge cannot express "not applicable".
    if (result.unobservedReason !== null) {
      deps.metrics.increment('ledger_reconciliation_unobserved_total', {
        asset: assetCode,
        reason: result.unobservedReason,
      })
    }

    const log = deps.logger.child({ job: RECONCILE_KIND, asset: assetCode })
    if (result.observedSource === 'unavailable') {
      // **A distinct message, because it demands a distinct action.** Both this and a drift freeze
      // withdrawals, but "the numbers disagree" sends an operator to the arithmetic while "nobody
      // observed the chain" sends them to the indexer feed. Logging them under one line would send
      // every unobserved asset hunting a discrepancy that was never measured — and this is the
      // state EMBER is in until Hearth's mainnet and its indexer feed exist, so it is the line that
      // will actually be read.
      //
      // AND THE REASON IS IN THE MESSAGE ITSELF, not only in the fields. This line was fatal, and
      // correct, and useless: it said the same thing when the chain was unfollowed and when this
      // service could not authenticate, which for months was the state the estate was actually in.
      // A `log.fatal` that cannot distinguish the expected case from the page is a fatal nobody
      // reads.
      log.fatal(`RECONCILIATION HAD NO CHAIN OBSERVATION (${String(result.unobservedReason)}) — withdrawals frozen`, {
        ...result,
        remedy: REMEDIES[result.unobservedReason ?? 'unreachable'],
      })
    } else if (result.froze) {
      // Pages. Drift beyond tolerance means the ledger can no longer prove it holds what it owes,
      // and every withdrawal it settles until this is explained may be paying out value that is
      // not there.
      log.fatal('RECONCILATION DRIFT EXCEEDED — withdrawals frozen', { ...result })
    } else if (result.unfroze) {
      log.warn('reconciliation clean; withdrawal freeze lifted', { ...result })
    } else if (result.status !== 'clean') {
      log.warn('reconciliation drift within tolerance', { ...result })
    } else {
      log.info('reconciliation clean', { ...result })
    }
  })

  /**
   * Rebuild the balances projection from the journal and compare.
   *
   * **A mismatch is a P0.** It means the projection and the journal disagree about how much money
   * exists, and until it is explained every balance this service has served is suspect. The job
   * does not attempt to repair it: overwriting the projection would destroy the evidence of how
   * the two came apart, and the difference between "the projection is stale" and "postings were
   * written that should not have been" is exactly what an operator needs to establish first.
   */
  runner.register(REBUILD_KIND, async () => {
    const report = await rebuildBalances(deps.sql)
    deps.metrics.set('ledger_balance_rebuild_mismatches', report.mismatches.length)

    const log = deps.logger.child({ job: REBUILD_KIND })
    if (report.clean) {
      log.info('balances projection matches a full journal replay', {
        checked: report.checked,
        postingsRead: report.postingsRead,
      })
      return
    }
    log.fatal('BALANCES PROJECTION DISAGREES WITH THE JOURNAL', {
      checked: report.checked,
      postingsRead: report.postingsRead,
      mismatches: report.mismatches.slice(0, 20),
      truncated: Math.max(0, report.mismatches.length - 20),
    })
  })

  runner.register(REAP_KIND, async () => {
    const removed = await reapIdempotencyKeys(deps.sql, deps.idempotencyTtlDays)
    if (removed > 0) {
      deps.logger.info('reaped idempotency keys', { removed, ttlDays: deps.idempotencyTtlDays })
    }
  })

  return runner
}
