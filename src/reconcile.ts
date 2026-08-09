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
 * Two halves of the invariant:
 *
 *   * **liability vs custody** — internal, and the half that catches `convertCoinToEmber`. This is
 *     what `observed_source = 'liability_sum'` records. It is a real check, and for an asset with
 *     no chain behind it (SHARD, USD) it is the only one available.
 *   * **custody vs chain** — the half that makes the economics valid FROM CHAIN, and the only half
 *     that means anything for an asset that lives on one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SECOND HALF WAS NEVER ONCE CHECKED, AND THE FIRST HALF WAS STANDING IN FOR IT.**
 *
 * The comment that used to sit here said the indexer "does not exist yet", and when it was written
 * that was true. It stopped being true — `micro-indexer` has Bitcoin, Solana and EVM families with
 * reorg handling — and nothing here changed. `indexerObservedTotal` stayed optional, and
 * `grep -rn indexerObservedTotal ledger/src` found it supplied in exactly one place in the whole
 * estate: a test. `jobs.ts` — the scheduled sweep, the only production caller — never passed it.
 *
 * So every run this service ever made on EMBER compared the ledger against the ledger and reported
 * clean. A fabricated deposit moves custody and liability together, so the books balance perfectly
 * about coin that does not exist; and because `clean` is the status that LIFTS a withdrawal freeze,
 * a vacuous run would delete a freeze a real observation had just set. The check that could not
 * fail also outranked the one that could.
 *
 * `reconcileAsset` no longer falls back. A chain asset with no reading records
 * `observed_source = 'unavailable'`, a NULL observed total, a NULL drift and `status = 'failed'` —
 * which freezes the asset and can never unfreeze it. Migration 11 makes all of that the schema's
 * rule rather than this function's, because a handler-only guard is bypassable by a bug, a
 * migration, or an operator with a psql connection.
 *
 * What no schema can do is verify the reading. `indexer_observed_total` is an assertion by the
 * caller, and a caller determined to fabricate one still can. That is the honest boundary: the
 * database can refuse a run that never had evidence, and it cannot audit evidence it is handed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
import { ON_CHAIN_ASSETS } from '@cloudsforge/contracts-chain'
import { withOutbox, type Db, type Tx } from './outbox.ts'
// The taxonomy is declared where it is DECIDED — beside the `catch` that classifies a transport
// failure — rather than here, where it is only written down. Importing it the other way round
// would put a vocabulary about HTTP into the module that does arithmetic on money.
//
// It was a type-only import until micro-org#275, and `isTransientUnobserved` is a deliberate
// exception rather than a relaxation: this module has to know whether an absence is expected to
// still be there in fifteen minutes, and re-deriving that here from reason names would be a second
// copy of a judgement about HTTP — the drift the comment above exists to prevent, made worse by
// being invisible. What crosses is a boolean about persistence. Nothing that can become a number.
import { isTransientUnobserved, type UnobservedReason } from './indexerclient.ts'

/**
 * Is this asset settled on a chain, and therefore only ever attestable BY a chain?
 *
 * `ON_CHAIN_ASSETS` (contracts/packages/chain/src/index.ts) is the estate's declaration and is
 * read here rather than restated. The `chain_assets` table migration 11 seeds is the same list in
 * the one other place that needs it — the database, which cannot import TypeScript — and
 * `reconcile.test.ts` asserts the two are equal so neither can drift in silence.
 *
 * **Not `isChainAsset` from contracts-money.** That function is `Object.hasOwn(CHAINS, code)`, and
 * `CHAINS` contains SHARD — carried with the comment "never used on chain; present so the record is
 * total". Using it here would demand an indexer feed for Shards, which have no chain to feed from,
 * and the mistake would look exactly like a working guard.
 */
export function isOnChainAsset(assetCode: LedgerAssetCode): boolean {
  return (ON_CHAIN_ASSETS as readonly string[]).includes(assetCode)
}

/**
 * The topic a finished reconciliation announces itself on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE NEVER EMITTED IT, AND THE ESTATE HAS BEEN LISTENING SINCE BEFORE THE SERVICE
 * EXISTED.** `micro-org`'s estate-wide check recorded it as `unemitted:ledger.reconciliation.
 * completed` and this repository re-verified the finding against its own source rather than taking
 * it on trust: the literal appeared nowhere in `ledger/src`, and the only outbox write in the whole
 * service was `ledger.entry.posted` at `entries.ts`.
 *
 * It is NOT the `custody.key.exported` shape and the difference decides the repair. Custody looked
 * unemitted but was in fact emitting `custody.export.completed` — the same fact under a name no
 * registry knew — so the fix there was a RENAME in one repository rather than an emit. Here there is
 * no second name to find: `grep -oE "'ledger\.[a-z_]+\.[a-z_]+'" src/*.ts` returns
 * `ledger.entry.posted` and two JOB KINDS (`ledger.balances.rebuild`, `ledger.idempotency.reap`),
 * and neither job kind ever reaches an outbox row. The fact was genuinely never put on the bus.
 *
 * Nor should it be deregistered, because it has readers and they are load-bearing:
 *
 *   - `activity/src/classify.ts` files it as `wallet.reconciliation_completed`, `internal`,
 *     reading `drift` off the payload. Dead code until this commit.
 *   - `analytics/src/catalogue.ts` records it as `reconciliation_completed`, deliberately
 *     impersonal, "kept because a reconciliation freeze explains a hole in every funnel that week".
 *     Dead code until this commit.
 *   - `notify/src/catalogue.ts` lists it under NON_NOTIFYING_TOPICS with a written reason — no
 *     individual user is its subject. That is a DECISION rather than a gap, and it stays correct.
 *   - `docs/ecosystem/05-user-journeys.md` J14 is an operator responding to a drift alert, and
 *     `server.ts` already serves `GET /reconciliation` returning runs and freezes. The console
 *     could show a drift only by polling; nothing told it a run had finished.
 *
 * So the answer to "does a completed reconciliation notify anyone" was: no, not by any route, and
 * three services had been written as though it did.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Registered `keyedBy: 'chain:network'` — the ordering partition is the CHAIN, not the asset, so
 * consecutive runs over one network arrive in order while two networks do not serialise against
 * each other. The asset is on the payload.
 */
export const RECONCILIATION_COMPLETED = 'ledger.reconciliation.completed'

export interface ReconcileInput {
  readonly assetCode: LedgerAssetCode
  readonly chain: string
  readonly network: 'mainnet' | 'testnet'
  readonly tolerance: AssetTolerance
  /**
   * The service name stamped on the outbox row.
   *
   * Required rather than defaulted: `producer` is checked against the topic's owner by
   * `validateEnvelope`, so a wrong or absent one is an envelope every consumer refuses. A default
   * here would make that a silent runtime fact instead of a call-site decision.
   */
  readonly producer: string
  /**
   * The observed total, when something outside the ledger can supply one.
   *
   * **Present** — it is the indexer's confirmed on-chain total; `observed_source = 'indexer'`.
   *
   * **Absent, and the asset is NOT chain-backed** (SHARD, USD) — the run compares Σ custody assets
   * against Σ user liabilities, both from this ledger, and records `liability_sum`. That is the
   * only check those assets can have and it is a real one: it catches a liability credited against
   * no custody position.
   *
   * **Absent, and the asset IS chain-backed** — the run records `unavailable` and `failed`. It does
   * not fall back to the ledger's own books, because a check of a chain asset that never looked at
   * a chain is not a weaker check, it is a different question wearing the answer's clothes.
   */
  readonly indexerObservedTotal?: bigint
  /**
   * Why there is no observation, when there is none.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **REQUIRED IN PRACTICE, AND OPTIONAL ONLY IN TYPE.** Migration 12's
   * `reconciliation_runs_reason_chk` refuses an `unavailable` run that does not carry one, so a
   * caller that omits it for a chain-backed asset gets a 23514 and no row — deliberately, because
   * the alternative is the state this field was added to end.
   *
   * A chain asset frozen because **Hearth is not followed** and a chain asset frozen because **this
   * service's ten-minute token expired fifteen minutes into a fifteen-minute job** wrote the same
   * row: `unavailable`, NULL total, NULL drift, `failed`. Both are correct records of "nobody
   * observed it". Only one of them is a fact about the chain, and the other is a fact about this
   * deployment's credentials — and for the life of the service they were the same line.
   *
   * `observed_source` says which side the comparison came from. It has no way to say why a side is
   * missing, and "missing" is the state that freezes the asset.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Ignored when `indexerObservedTotal` is present: an observed run has no absence to explain, and
   * the schema refuses one that claims otherwise.
   */
  readonly unobservedReason?: UnobservedReason
  /**
   * Where the observed total sits, split by custody label — for the freeze message, and nothing else.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * A drift freeze used to say two numbers: what the ledger thinks custody holds, and what the chain
   * showed. Two numbers establish that the estate and the chain disagree. They do not say WHERE, and
   * "where" is the whole of the next hour: deposit balances are users' coin moved by `micro-wallet`,
   * treasury float is the platform's own moved by `micro-settlement`, and a shortfall in one is a
   * different incident — different code, different blast radius — from a shortfall in the other. The
   * 2026-08-05 freeze was a treasury registration and read, from the message, exactly like a
   * deposit-sweep shortfall.
   *
   * **A string, and it enters no arithmetic.** It is interpolated into `asset_freezes.reason` and
   * touches nothing else: not the drift, not the status, not the row. `indexerclient.breakdownFrom`
   * builds and bounds it; this module clamps the length again below, because a value that has
   * travelled from another service's JSON to a column an operator reads is worth distrusting twice.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly observedBreakdown?: string
}

/**
 * Where the observed side of the comparison came from.
 *
 * `'unavailable'` is not an error code — the run happened, and the fact it establishes is "nobody
 * could observe this asset", which is itself worth recording and acting on.
 */
export type ObservedSource = 'liability_sum' | 'indexer' | 'unavailable'

export interface ReconciliationResult {
  readonly id: string
  readonly assetCode: string
  readonly chain: string
  readonly network: string
  readonly ledgerCustodyTotal: string
  /** `null` when nothing observed. **Never `'0'`** — a zero here would read as a measurement. */
  readonly indexerObservedTotal: string | null
  /**
   * Ledger minus observed. **The sign carries the meaning and must not be discarded**, and neither
   * must its absence: `null` means there was no second number to subtract, not that there was no
   * difference.
   */
  readonly drift: string | null
  readonly status: ReconciliationStatus
  readonly observedSource: ObservedSource
  /**
   * Why nothing was observed. Non-null exactly when `observedSource` is `'unavailable'`, which the
   * schema enforces rather than this type.
   */
  readonly unobservedReason: UnobservedReason | null
  readonly froze: boolean
  readonly unfroze: boolean
  /**
   * How many runs in a row, ending with this one, observed nothing. `null` when this run observed.
   *
   * Counted from the runs table rather than held in memory: the sweep is a leased job that may be
   * claimed by a different replica every time, so a counter in a process is a counter that resets
   * on the deploy this whole mechanism exists to survive.
   */
  readonly unobservedRuns: number | null
  /**
   * This run failed to observe and deliberately did not freeze — see `UNOBSERVED_RUNS_BEFORE_FREEZE`.
   *
   * **Never true of a drift.** A measured discrepancy freezes on the first run, as it always has.
   * This says only "nobody could look, and not yet often enough in a row to act on".
   */
  readonly freezeDeferred: boolean
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
async function totalFor(sql: Db | Tx, type: string, assetCode: string, subject?: string): Promise<bigint> {
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
 * How many consecutive unobserved runs a TRANSIENT reason must produce before it freezes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * micro-org#275. The sweep runs every fifteen minutes (`jobs.ts`), so `2` means: one blip is
 * absorbed, and an observer that is genuinely broken still freezes the asset within one further
 * sweep. Measured against the incident it is written for — mainnet EMBER, 2026-08-08, restart
 * window 23:23:2x, clean again at 23:38:29 — a restart is seconds wide and fifteen minutes is
 * three orders of magnitude more room than it needs. `3` was the alternative the issue offered and
 * it buys nothing here: it would cost another quarter hour of not knowing, against a window
 * already covered many times over.
 *
 * **A constant rather than an environment variable, on purpose.** The number decides how long the
 * estate is willing to be unable to check itself, which is a property of the design and not of a
 * deployment; a per-estate knob is a per-estate answer to "why did this not freeze", and the value
 * that would actually be reached for under pressure is the one that turns the mechanism off.
 *
 * **It does not weaken the fail-closed rule, it delays it, and only for reasons that clear by
 * themselves.** A structural reason still freezes on the first run. A measured drift still freezes
 * on the first run. Nothing about the comparison changes: an unobserved run still records NULL,
 * NULL, `failed`, and still cannot lift an existing freeze.
 *
 * The alternating case — observe cleanly, fail, observe cleanly, fail — never reaches the
 * threshold and never freezes. That is correct rather than a hole: every other sweep is a real
 * observation of a real chain reporting drift zero, so there is no interval in which the asset is
 * unbacked and unnoticed. What is deferred is a verdict about the OBSERVER.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const UNOBSERVED_RUNS_BEFORE_FREEZE = 2

/**
 * How many runs in a row, most recent first, observed nothing — capped at `limit`.
 *
 * Called inside the reconciliation transaction and AFTER this run's row is inserted, so the run
 * being decided counts itself. Reading its own row rather than adding one is what makes the count
 * the same whichever replica claimed the lease.
 *
 * **Counts `observed_source`, never `unobserved_reason`.** The column that says an observation
 * happened is the one migration 11 constrains against the total and the drift, so it cannot
 * disagree with them; and the history holds `unrecorded`, migration 12's honest back-fill for rows
 * written before a reason was stored, which is not a member of `UnobservedReason` and must not
 * have to be classified to be counted.
 *
 * Scoped to `asset_code` alone, matching the primary key of `asset_freezes`: the thing being
 * decided is one asset's freeze, so the evidence must be that asset's runs and nothing narrower.
 * `reconciliation_runs_asset_idx` is `(asset_code, started_at desc)`, which is exactly this scan.
 * `id` breaks the tie because it is a UUIDv7 and therefore already time-ordered — two runs sharing
 * a `started_at` are two rows of one transaction's `now()`, and ordering them by insert order is
 * the only reading that is not arbitrary.
 */
async function consecutiveUnobservedRuns(sql: Tx, assetCode: string, limit: number): Promise<number> {
  const rows = await sql<{ observed_source: string }[]>`
    select observed_source
      from reconciliation_runs
     where asset_code = ${assetCode}
     order by started_at desc, id desc
     limit ${limit}
  `
  let consecutive = 0
  for (const row of rows) {
    // `break`, and NOT `continue`. Measured 2026-08-09 by hand-mutating this line: at
    // `UNOBSERVED_RUNS_BEFORE_FREEZE = 2` the two forms are arithmetically identical and no test
    // moves, because the window is at most two rows and the first is always this run's own
    // `unavailable` — so the only shapes reachable are [unavailable] and [unavailable, X], which
    // both count the same either way. Raise the threshold to 3 and the forms diverge: the same
    // mutation then reddens 'an observed run RESETS the count' (5 failures against the 4 the
    // threshold change alone causes). It is written as `break` because CONSECUTIVE is the property
    // intended, not because today's constant makes it matter.
    if (row.observed_source !== 'unavailable') break
    consecutive += 1
  }
  return consecutive
}

/** Longer than any honest breakdown of eight buckets, and short enough to read in a console cell. */
const MAX_BREAKDOWN = 300

/**
 * The breakdown clause, or nothing at all.
 *
 * The second clamp on a value `indexerclient.breakdownFrom` has already bounded, and deliberately
 * not a shared helper: this module is the one that writes the column, and the property "a freeze
 * reason is a bounded string" should hold for every caller of `reconcile`, including tests, future
 * callers, and any observer that is not the HTTP client. A guarantee that lives only in the producer
 * is a guarantee the next producer will not know about.
 *
 * Truncation is marked `…` and the phrase is prefixed with `=` rather than being run on, so a reader
 * can see where the checkable arithmetic ends and the reported split begins. An empty or
 * whitespace-only value is absent rather than an empty clause.
 */
function observedBreakdownFor(breakdown: string | undefined): string {
  if (breakdown === undefined) return ''
  const trimmed = breakdown.trim()
  if (trimmed.length === 0) return ''
  const clamped =
    trimmed.length > MAX_BREAKDOWN ? `${trimmed.slice(0, MAX_BREAKDOWN)}…` : trimmed
  return ` = ${clamped}`
}

/**
 * Run one asset's reconciliation and act on the result.
 *
 * The run row is written whatever the outcome, including a clean one. A reconciliation that only
 * records failures cannot answer "when was this last checked", which is the question asked first
 * when a drift is finally noticed.
 *
 * ## Everything is ONE transaction, and both halves of that are repairs
 *
 * **The two totals are read in one snapshot.** They were two statements outside any transaction, so
 * a posting landing between them was counted on one side and not the other — a phantom drift, from
 * a ledger that balances perfectly. Since drift beyond tolerance FREEZES WITHDRAWALS for the asset,
 * that is not a cosmetic race: it is a service that stops paying people because two SELECTs
 * disagreed. Reading both inside one transaction is the whole fix, and it costs nothing.
 *
 * **The event is written with the change**, which is rule 5 of docs/ecosystem/03 §2 and the reason
 * `withOutbox` exists. The run row, the freeze or unfreeze, and the announcement of both now succeed
 * or fail together. Emitting after commit would drop the event when the process dies in the gap —
 * and the event this drops is the one that tells an operator withdrawals just stopped.
 */
export async function reconcileAsset(sql: Db, input: ReconcileInput): Promise<ReconciliationResult> {
  return withOutbox(sql, input.producer, async (tx, emit) => {
    const custodyTotal = await totalFor(tx, 'asset', input.assetCode, 'custody')

    /**
     * **The three-way choice this whole commit is about.**
     *
     * It was a ternary — `indexerObservedTotal !== undefined ? 'indexer' : 'liability_sum'` — and
     * no production caller ever took the first branch, so the reconciliation guarding "every EMBER
     * balance is backed by real chain holdings" compared the ledger against itself, forever,
     * unfailingly, on the one asset where that means least.
     *
     * The middle case is the new one and it is the point: a chain asset with no reading is a
     * FAILURE, not a fallback. `freezesWithdrawals('failed')` is true, so the asset freezes; and
     * since only `status === 'clean'` lifts a freeze and an unobserved run can never be clean, such
     * a run can never release one either. Both consequences are correct — an asset whose backing
     * nobody can see is an asset nobody should be able to withdraw.
     */
    let observedSource: ObservedSource
    let observedTotal: bigint | null
    let unobservedReason: UnobservedReason | null = null
    if (input.indexerObservedTotal !== undefined) {
      observedSource = 'indexer'
      observedTotal = input.indexerObservedTotal
    } else if (isOnChainAsset(input.assetCode)) {
      observedSource = 'unavailable'
      observedTotal = null
      // **The fallback is `'unreachable'`, not `'unknown'`, and it is a last resort rather than a
      // default.** Every production path supplies a reason — `jobs.ts` takes it from the client's
      // own classification — and migration 12 refuses a row without one, so this branch is reached
      // only by a caller that forgot. It resolves to the most conservative honest reading of "a
      // caller had no total and said nothing about why": nobody reached the indexer. It must never
      // be a value that reads as diagnosed, because a wrong diagnosis is worse than a coarse one.
      unobservedReason = input.unobservedReason ?? 'unreachable'
    } else {
      observedSource = 'liability_sum'
      observedTotal = await totalFor(tx, 'liability', input.assetCode)
    }

    // `null`, never `0n`. `computeDrift(custodyTotal, 0n)` would state that the chain holds nothing
    // — a measurement — where the truth is that nobody measured. The schema refuses the lie too
    // (`reconciliation_runs_drift_chk`), so this cannot be undone here by a later edit.
    const drift = observedTotal === null ? null : computeDrift(custodyTotal, observedTotal)
    const status: ReconciliationStatus =
      drift === null
        ? 'failed'
        : reconciliationStatus({ assetCode: input.assetCode, drift }, input.tolerance)

    const runRows = await tx<{ id: string }[]>`
      insert into reconciliation_runs (
        chain, network, asset_code, finished_at, ledger_custody_total,
        indexer_observed_total, drift, status, observed_source, unobserved_reason
      ) values (
        ${input.chain}, ${input.network}, ${input.assetCode}, now(),
        ${custodyTotal.toString()}::numeric(78,0),
        ${observedTotal === null ? null : observedTotal.toString()}::numeric(78,0),
        ${drift === null ? null : drift.toString()}::numeric(78,0),
        ${status}, ${observedSource}, ${unobservedReason}
      )
      returning id
    `
    const runId = runRows[0]!.id

    let froze = false
    let unfroze = false

    /**
     * How many runs in a row have now failed to observe, and whether this one acts on it.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THE DEFECT micro-org#275 REPORTS IS THAT THESE TWO SENTENCES WERE ONE ROW:**
     *
     *   * *"I looked and the numbers disagree."* Custody says one thing, the chain says another.
     *     That is a solvency signal and freezing is correct and urgent.
     *   * *"I could not look."* No credential, an upstream mid-restart, a refused connection.
     *     Nothing whatsoever is known about solvency, in either direction, and the prior state of
     *     the world is unchanged.
     *
     * The second was treated as the first, so a rolling restart froze a healthy asset for fifteen
     * minutes on 2026-08-08 and would do so again on the next deploy that touched identity.
     *
     * **What this does NOT do, and the distinction the whole release before it was about:** it
     * does not invent a total, does not carry a previous one forward, does not fall back to the
     * ledger's own books, and does not let the run be anything but `failed`. `observedTotal` is
     * still `null`, `drift` is still `null`, and migration 11 still refuses the row if either
     * becomes a number. *Nothing is not zero.* The only question asked here is **how many times in
     * a row nobody has been able to look**, which is a fact about this service's runs table and
     * about no chain at all — a count of measurements that did not happen can never be mistaken
     * for a measurement.
     *
     * Deferral is only ever reached from `observedTotal === null`. A drift is a number somebody
     * measured, and it freezes on the first run exactly as it always has.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const unobservedRuns =
      observedTotal === null
        ? await consecutiveUnobservedRuns(tx, input.assetCode, UNOBSERVED_RUNS_BEFORE_FREEZE)
        : null
    const freezeDeferred =
      unobservedRuns !== null &&
      unobservedReason !== null &&
      isTransientUnobserved(unobservedReason) &&
      unobservedRuns < UNOBSERVED_RUNS_BEFORE_FREEZE

    if (freezesWithdrawals(status) && !freezeDeferred) {
      // The reason an operator reads first, and the two cases say genuinely different things. A
      // drift is arithmetic they can check. An unavailable observation is not a small drift and
      // must not be phrased as one — there is no number, and printing "drift 0" beside a freeze
      // would send them looking for a discrepancy that was never measured.
      //
      // Discriminated on `observedTotal`, which is the value actually interpolated, rather than on
      // `drift`. The two are null together by construction and the schema enforces it, but narrowing
      // on one to dereference the other needs a `!` that would survive a future edit breaking the
      // pairing. Narrowing on the thing being read needs no assertion at all.
      //
      // The unobserved message now NAMES THE CAUSE, and that is the difference between a freeze an
      // operator can act on and one they can only stare at. `asset_freezes.reason` is what the
      // console and `GET /reconciliation` show first; until this change it said "no indexer
      // observation" whether the chain was unlaunched or this service's own token had expired
      // fifteen minutes into a fifteen-minute job. Those need opposite responses — wait, versus
      // look at identity — and they were one sentence.
      //
      // The drift message now also says WHERE the observed side sits, when the observer said. See
      // `observedBreakdown` on the input: "drift 3" tells an operator the estate and the chain
      // disagree; "drift 3 … observed 41000000 = deposit: 41000000 over 12 addresses, treasury: 0
      // over 1" tells them which of two different incidents they are in. Appended rather than
      // interleaved, so the arithmetic reads identically to every freeze recorded before this
      // change and the prose that cannot be checked comes after the numbers that can.
      const breakdown = observedBreakdownFor(input.observedBreakdown)
      const reason =
        observedTotal === null
          ? `reconciliation failed: no indexer observation for on-chain asset ${input.assetCode}` +
            ` (custody ${custodyTotal.toString()}; chain holdings UNKNOWN, not zero;` +
            ` reason ${String(unobservedReason)})`
          : `reconciliation ${status}: drift ${String(drift)} (custody ${custodyTotal.toString()}, observed ${observedTotal.toString()}${breakdown})`

      // `on conflict do update` rather than `do nothing`: a still-drifting asset must carry the
      // reason and run id of the LATEST run, or an operator reads the arithmetic of a run that has
      // since been superseded.
      await tx`
        insert into asset_freezes (asset_code, reason, run_id)
        values (${input.assetCode}, ${reason}, ${runId})
        on conflict (asset_code) do update
          set reason = excluded.reason, run_id = excluded.run_id, frozen_at = now()
      `
      froze = true
    } else if (status === 'clean') {
      // A deferred run reaches NEITHER of these branches, and that is the whole of what deferral
      // means: `asset_freezes` is not written and not deleted. An asset already frozen — for a
      // drift, or for a structural absence — stays frozen and keeps the reason and run id of the
      // run that established it. Refreshing that row with "no indexer observation" would replace an
      // arithmetic an operator can check with a sentence about a token, on the strength of a blip.
      // **Only an exactly-zero run lifts a freeze.** `drift_within_tolerance` does not, and that
      // asymmetry is on purpose: the bar to lift is higher than the bar that set it, so an asset
      // sitting near the tolerance boundary cannot flap in and out of frozen with every run. An
      // operator gets one freeze and one deliberate resolution rather than an alert storm.
      const removed = await tx`delete from asset_freezes where asset_code = ${input.assetCode}`
      unfroze = removed.count > 0
    }

    const result: ReconciliationResult = {
      id: runId,
      assetCode: input.assetCode,
      chain: input.chain,
      network: input.network,
      ledgerCustodyTotal: custodyTotal.toString(),
      indexerObservedTotal: observedTotal === null ? null : observedTotal.toString(),
      drift: drift === null ? null : drift.toString(),
      status,
      observedSource,
      unobservedReason,
      froze,
      unfroze,
      unobservedRuns,
      freezeDeferred,
    }

    emit({
      topic: RECONCILIATION_COMPLETED,
      // The registry's `keyedBy`, not this service's preference. `chain:network` is the ordering
      // partition: consecutive runs over one network arrive in the order they were written, and two
      // networks do not serialise against each other. The ASSET is on the payload — keying by it
      // would give every asset its own partition and lose the ordering between a freeze on one asset
      // and the run that lifted it on another.
      key: `${input.chain}:${input.network}`,
      // **Every number is a STRING, and that is not a style choice.** These are `numeric(78,0)` and
      // routinely exceed 2^53; a JSON number would round them, and rounding the two sides of a
      // reconciliation by different amounts invents the exact drift this job exists to detect.
      // `activity/src/classify.ts` reads `drift` through its `amount()` reader, which takes a
      // string.
      //
      // **`drift` and `indexerObservedTotal` are now `string | null`, and null is deliberate on the
      // wire.** A consumer must be able to tell "no difference" from "no observation"; sending 0 for
      // both is the defect this commit removes, re-committed one layer out. `amount()` at
      // `activity/src/classify.ts` requires `typeof value === 'string'` and returns null
      // otherwise, so its summary already degrades to "Reconciliation completed." rather than
      // announcing a drift of zero that nobody measured — checked, not assumed.
      payload: {
        runId,
        assetCode: result.assetCode,
        chain: result.chain,
        network: result.network,
        status: result.status,
        drift: result.drift,
        ledgerCustodyTotal: result.ledgerCustodyTotal,
        indexerObservedTotal: result.indexerObservedTotal,
        observedSource: result.observedSource,
        // **On the wire, and `null` rather than absent.** A subscriber must be able to tell an
        // unfollowed chain from an authentication failure without reading this service's logs, and
        // `activity`'s and `analytics`' readers of this topic both take the payload as it arrives.
        // JSON drops `undefined`, and an absent key here would be read as "observed" by anything
        // that checks presence — the same laundering `drift: null` exists to prevent, one field
        // over. Every value is a member of `UnobservedReason`; no error message and no URL reaches
        // this payload, so nothing here can carry a token into a subscriber's log.
        unobservedReason: result.unobservedReason,
        // The two facts an operator acts on, stated rather than inferred from `status`. A reader
        // that derived "withdrawals just stopped" from the status string would have to know the
        // freeze rule — which lives in `@cloudsforge/contracts-money` and is deliberately asymmetric
        // (only an exactly-clean run lifts). Booleans on the wire, never undefined: JSON drops
        // undefined and every reader then sees the safe-looking `false`.
        froze: result.froze,
        unfroze: result.unfroze,
        // **"Could not look, and have not acted on it yet" is a third state, and it is stated
        // rather than inferred.** `froze: false` beside a non-null `unobservedReason` used to be
        // impossible; since micro-org#275 it is the ordinary shape of a deploy window, and a
        // consumer that read the pair as "nothing to see" would be wrong in the one direction that
        // matters. Additive to the payload, which the registry allows — `payloadType` names a shape
        // the producer owns and "a payload change that is not additive is a major"
        // (`contracts/packages/events`). `unobservedRuns` is a count of runs, never an amount, and
        // is `null` exactly when something was observed.
        unobservedRuns: result.unobservedRuns,
        freezeDeferred: result.freezeDeferred,
      },
      // **No actor and no correlation id, deliberately.** This is a leased job woken by a schedule:
      // there is no principal and no inbound request. The relay maps a null actor to the contract's
      // `system` — its own value for "no principal did this" — and a null correlation id to the
      // event id. Inventing a user here would put a machine's decision in somebody's name.
    })

    return result
  })
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
  /** `null` when the run observed nothing. Distinguishable from an observed zero, on purpose. */
  readonly indexerObservedTotal: string | null
  readonly drift: string | null
  readonly status: ReconciliationStatus
  readonly observedSource: string
  /**
   * Why nothing was observed, for the run that has no observation. `null` otherwise.
   *
   * This is the field an operator reads FIRST on a frozen chain asset, because it is the one that
   * decides whether the answer is "the chain has not launched, this is expected" or "this
   * deployment cannot authenticate and the chain is fine". `GET /reconciliation` serves it.
   */
  readonly unobservedReason: string | null
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
      indexer_observed_total: string | null
      drift: string | null
      status: string
      observed_source: string
      unobserved_reason: string | null
    }[]
  >`
    select distinct on (asset_code)
           id, asset_code, chain, network, started_at, finished_at,
           ledger_custody_total::text as ledger_custody_total,
           indexer_observed_total::text as indexer_observed_total,
           drift::text as drift, status, observed_source, unobserved_reason
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
    unobservedReason: row.unobserved_reason,
  }))
}
