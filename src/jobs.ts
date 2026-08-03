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
   * **THIS HANDLER IS WHERE THE INDEXER CALL GOES, AND IT IS THE REASON EVERY CHAIN ASSET NOW
   * FAILS.** Read this before "fixing" the failures.
   *
   * `reconcileAsset` takes an optional `indexerObservedTotal` and this call site has never supplied
   * one — not once, in the life of the service. That is the whole defect: the ternary it fed
   * silently selected `observed_source = 'liability_sum'`, so the reconciliation guarding "every
   * EMBER balance is backed by real chain holdings" compared this ledger against this ledger.
   * `reconcileAsset` no longer falls back for a chain asset, so until the call below exists, EMBER
   * records `unavailable` / `failed` and stays frozen. **That is the correct state**, and the
   * argument for it is on `Env.reconcileAssets` in env.ts.
   *
   * What `micro-indexer` must expose before this can be wired, stated precisely because the obvious
   * endpoint is the wrong one:
   *
   *   * **An aggregate, not a per-address read.** It has `watched_addresses (chain, network,
   *     address)` and per-address routes, but nothing that returns Σ confirmed native balance over
   *     the custody set. Summing per-address reads HERE would be wrong: this service does not know
   *     which addresses are custody's, and the set changes under it mid-sweep.
   *   * **Confirmed only, at the chain's own depth.** `chainSpec(asset).confirmations`, so a
   *     reorg-eligible block never becomes a drift that freezes withdrawals.
   *   * **Coverage, and a refusal rather than a partial sum.** This is the one that will get
   *     written wrong. A total missing one unreadable address is LOW, which reads here as a
   *     positive drift — "the ledger claims coin the chain does not show" — and freezes the asset
   *     on the strength of an RPC timeout. The indexer already holds this exact line for token
   *     balances (`indexer/src/server.ts:479`: "a missing balance is missing, never zero, because
   *     zero is what evicts a token-gated member"), and the aggregate must hold it too: incomplete
   *     coverage must leave `indexerObservedTotal` UNDEFINED here, which records `unavailable` and
   *     `failed`. A partial sum passed off as a total is the same lie this release removed from the
   *     run row, sourced one service upstream.
   *
   * `micro-deploy` then owns the URL and the timeout. A missing or unreachable indexer must reach
   * `reconcileAsset` as `undefined` — never as `0n`, which asserts an empty chain.
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

    const result = await reconcileAsset(deps.sql, {
      assetCode: assetCode as LedgerAssetCode,
      chain: chainNameFor(assetCode as LedgerAssetCode),
      network,
      tolerance: deps.assetTolerance,
      producer: deps.producer,
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

    const log = deps.logger.child({ job: RECONCILE_KIND, asset: assetCode })
    if (result.observedSource === 'unavailable') {
      // **A distinct message, because it demands a distinct action.** Both this and a drift freeze
      // withdrawals, but "the numbers disagree" sends an operator to the arithmetic while "nobody
      // observed the chain" sends them to the indexer feed. Logging them under one line would send
      // every unobserved asset hunting a discrepancy that was never measured — and this is the
      // state EMBER is in until Hearth's mainnet and its indexer feed exist, so it is the line that
      // will actually be read.
      log.fatal('RECONCILIATION HAD NO CHAIN OBSERVATION — withdrawals frozen', { ...result })
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
