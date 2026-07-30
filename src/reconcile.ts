/**
 * Reconciliation, and the withdrawal freeze it drives.
 *
 * 04-domain-model.md §2.4 — **the invariant the whole platform rests on:** for each asset, the sum
 * of user liability accounts must equal the sum of custody asset accounts, and the custody total
 * must equal what the indexer observes on chain, within a stated per-chain tolerance. Exceeding
 * tolerance **freezes withdrawals for that asset** and pages.
 *
 * Nothing like this exists today, in any direction. The named consequence is
 * `convertCoinToEmber`, which credits custodial EMBER with no on-chain movement behind it — a
 * liability minted against nothing, which nothing in the estate can currently detect. That defect
 * shows up here as a **positive** drift: the ledger believes we hold coin the other side does not
 * show.
 *
 * Two halves of the invariant, and only one of them can be checked today:
 *
 *   * **liability vs custody** — internal, checkable now, and the half that catches
 *     `convertCoinToEmber`. This is what `observed_source = 'liability_sum'` records.
 *   * **custody vs chain** — needs the indexer service, which does not exist yet
 *     (00-current-state.md §3.4, AD-07). The column names and the run shape are the domain
 *     model's, so wiring the indexer in later adds a caller, not a migration.
 *
 * The arithmetic — `computeDrift`, `withinTolerance`, `reconciliationStatus`,
 * `freezesWithdrawals` — is `@cloudsforge/contracts-money` and is not restated here. In particular
 * `withinTolerance` fails **closed** on an asset with no configured tolerance, and this file must
 * not undo that by supplying a default.
 */

import {
  type AssetTolerance,
  type LedgerAssetCode,
  type ReconciliationStatus,
  computeDrift,
  freezesWithdrawals,
  reconciliationStatus,
} from '@cloudsforge/contracts-money'
import type { Db } from './outbox.ts'

export interface ReconcileInput {
  readonly assetCode: LedgerAssetCode
  readonly chain: string
  readonly network: 'mainnet' | 'testnet'
  readonly tolerance: AssetTolerance
  /**
   * The observed total, when something outside the ledger can supply one.
   *
   * Absent — the run compares Σ custody assets against Σ user liabilities, both from this ledger,
   * and records `observed_source = 'liability_sum'`. Present — it is the indexer's confirmed
   * on-chain total and the run records `observed_source = 'indexer'`.
   */
  readonly indexerObservedTotal?: bigint
}

export interface ReconciliationResult {
  readonly id: string
  readonly assetCode: string
  readonly chain: string
  readonly network: string
  readonly ledgerCustodyTotal: string
  readonly indexerObservedTotal: string
  /** Ledger minus observed. **The sign carries the meaning and must not be discarded.** */
  readonly drift: string
  readonly status: ReconciliationStatus
  readonly observedSource: 'liability_sum' | 'indexer'
  readonly froze: boolean
  readonly unfroze: boolean
}

/**
 * Σ of every account of one type for one asset, from the projection.
 *
 * The projection rather than the journal, deliberately: `rebuildBalances` already replays the
 * journal and compares it against the projection, so summing the projection here composes two
 * independent checks — "the projection matches the journal" and "the projection's liabilities
 * match its custody" — instead of folding both into one query that could only ever fail as a
 * single undifferentiated alarm. If the projection has drifted from the journal, the rebuild job
 * says so and names the account.
 */
async function totalFor(sql: Db, type: string, assetCode: string, subject?: string): Promise<bigint> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(b.amount), 0)::text as total
      from balances b
      join accounts a on a.id = b.account_id
     where a.type = ${type}
       and b.asset_code = ${assetCode}
       and (${subject ?? null}::text is null or a.subject = ${subject ?? null})
  `
  return BigInt(rows[0]?.total ?? '0')
}

/**
 * Run one asset's reconciliation and act on the result.
 *
 * The run row is written whatever the outcome, including a clean one. A reconciliation that only
 * records failures cannot answer "when was this last checked", which is the question asked first
 * when a drift is finally noticed.
 */
export async function reconcileAsset(sql: Db, input: ReconcileInput): Promise<ReconciliationResult> {
  const custodyTotal = await totalFor(sql, 'asset', input.assetCode, 'custody')

  const observedSource = input.indexerObservedTotal !== undefined ? 'indexer' : 'liability_sum'
  const observedTotal =
    input.indexerObservedTotal ?? (await totalFor(sql, 'liability', input.assetCode))

  const drift = computeDrift(custodyTotal, observedTotal)
  const status = reconciliationStatus({ assetCode: input.assetCode, drift }, input.tolerance)

  const runRows = await sql<{ id: string }[]>`
    insert into reconciliation_runs (
      chain, network, asset_code, finished_at, ledger_custody_total,
      indexer_observed_total, drift, status, observed_source
    ) values (
      ${input.chain}, ${input.network}, ${input.assetCode}, now(),
      ${custodyTotal.toString()}::numeric(78,0),
      ${observedTotal.toString()}::numeric(78,0),
      ${drift.toString()}::numeric(78,0),
      ${status}, ${observedSource}
    )
    returning id
  `
  const runId = runRows[0]!.id

  let froze = false
  let unfroze = false

  if (freezesWithdrawals(status)) {
    // `on conflict do update` rather than `do nothing`: a still-drifting asset must carry the
    // reason and run id of the LATEST run, or an operator reads the arithmetic of a run that has
    // since been superseded.
    await sql`
      insert into asset_freezes (asset_code, reason, run_id)
      values (
        ${input.assetCode},
        ${`reconciliation ${status}: drift ${drift.toString()} (custody ${custodyTotal.toString()}, observed ${observedTotal.toString()})`},
        ${runId}
      )
      on conflict (asset_code) do update
        set reason = excluded.reason, run_id = excluded.run_id, frozen_at = now()
    `
    froze = true
  } else if (status === 'clean') {
    // **Only an exactly-zero run lifts a freeze.** `drift_within_tolerance` does not, and that
    // asymmetry is on purpose: the bar to lift is higher than the bar that set it, so an asset
    // sitting near the tolerance boundary cannot flap in and out of frozen with every run. An
    // operator gets one freeze and one deliberate resolution rather than an alert storm.
    const removed = await sql`delete from asset_freezes where asset_code = ${input.assetCode}`
    unfroze = removed.count > 0
  }

  return {
    id: runId,
    assetCode: input.assetCode,
    chain: input.chain,
    network: input.network,
    ledgerCustodyTotal: custodyTotal.toString(),
    indexerObservedTotal: observedTotal.toString(),
    drift: drift.toString(),
    status,
    observedSource,
    froze,
    unfroze,
  }
}

export interface FreezeView {
  readonly assetCode: string
  readonly frozenAt: string
  readonly reason: string
  readonly runId: string | null
}

/** Which assets currently refuse withdrawals. Read by `/readyz` consumers and by operators. */
export async function listFreezes(sql: Db): Promise<FreezeView[]> {
  const rows = await sql<
    { asset_code: string; frozen_at: Date; reason: string; run_id: string | null }[]
  >`
    select asset_code, frozen_at, reason, run_id from asset_freezes order by asset_code
  `
  return rows.map((row) => ({
    assetCode: row.asset_code,
    frozenAt: row.frozen_at.toISOString(),
    reason: row.reason,
    runId: row.run_id,
  }))
}

export interface ReconciliationRunView {
  readonly id: string
  readonly assetCode: string
  readonly chain: string
  readonly network: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly ledgerCustodyTotal: string
  readonly indexerObservedTotal: string
  readonly drift: string
  readonly status: ReconciliationStatus
  readonly observedSource: string
}

/** The most recent run per asset, which is what a dashboard and an operator both want first. */
export async function latestRuns(sql: Db): Promise<ReconciliationRunView[]> {
  const rows = await sql<
    {
      id: string
      asset_code: string
      chain: string
      network: string
      started_at: Date
      finished_at: Date | null
      ledger_custody_total: string
      indexer_observed_total: string
      drift: string
      status: string
      observed_source: string
    }[]
  >`
    select distinct on (asset_code)
           id, asset_code, chain, network, started_at, finished_at,
           ledger_custody_total::text as ledger_custody_total,
           indexer_observed_total::text as indexer_observed_total,
           drift::text as drift, status, observed_source
      from reconciliation_runs
     order by asset_code, started_at desc
  `
  return rows.map((row) => ({
    id: row.id,
    assetCode: row.asset_code,
    chain: row.chain,
    network: row.network,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    ledgerCustodyTotal: row.ledger_custody_total,
    indexerObservedTotal: row.indexer_observed_total,
    drift: row.drift,
    status: row.status as ReconciliationStatus,
    observedSource: row.observed_source,
  }))
}
