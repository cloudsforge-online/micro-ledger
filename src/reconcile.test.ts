/**
 * Reconciliation and the withdrawal freeze.
 *
 * 04-domain-model.md §2.4 — the invariant the whole platform rests on: for each asset, Σ user
 * liabilities must equal Σ custody assets, and drift beyond tolerance **freezes withdrawals for
 * that asset**.
 *
 * The named defect this catches is `convertCoinToEmber`, which credits custodial EMBER with no
 * on-chain movement behind it — a liability minted against nothing. It appears here as a NEGATIVE
 * drift when the liability side exceeds custody. Nothing in the estate detects this today, in
 * either direction.
 *
 * The freeze is only worth having if `POST /entries` actually consults it, so the last tests here
 * post through the real path and assert that a withdrawal is refused while a deposit and a refund
 * are not.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { AssetFrozenError, postEntry, type PostEntryDeps } from './entries.ts'
import { requestFingerprint } from './idempotency.ts'
import {
  RECONCILIATION_COMPLETED,
  UNOBSERVED_RUNS_BEFORE_FREEZE,
  listFreezes,
  latestRuns,
  reconcileAsset,
} from './reconcile.ts'
import {
  UNOBSERVED_PERSISTENCE,
  UNOBSERVED_REASONS,
  isTransientUnobserved,
  type UnobservedReason,
} from './indexerclient.ts'
import { topicSpec } from '@cloudsforge/contracts-events'
import { ON_CHAIN_ASSETS } from '@cloudsforge/contracts-chain'
import { KEYED_BY, envelopeDefects } from './topics.ts'
import {
  ALICE,
  custodyAccount,
  depositEntry,
  enabled,
  freshKey,
  migrateTestDb,
  openDb,
  resetLedger,
  skip,
  userAccount,
  withdrawalEntry,
} from './testsupport.ts'
import { buildEnvelope, type Db } from './outbox.ts'

let sql: postgres.Sql
const db = () => sql as unknown as Db
const deps = (): PostEntryDeps => ({ sql: db(), producer: 'ledger' })
const post = (request: Parameters<typeof postEntry>[1]) =>
  postEntry(deps(), request, requestFingerprint(request as unknown))

/**
 * `unobservedReason` is explicit wherever an unobserved run's FREEZE is the subject.
 *
 * Since micro-org#275 the reason decides when the freeze is written: a structural one freezes on
 * the first run, a transient one after `UNOBSERVED_RUNS_BEFORE_FREEZE` in a row. Omitting it falls
 * back to `unreachable`, which is transient — so a case that means "this freezes" and does not say
 * why it could not observe is a case asserting the opposite of what it reads as.
 */
const run = (
  assetCode: 'SHARD' | 'EMBER',
  tolerance: Record<string, bigint> = {},
  unobservedReason?: UnobservedReason,
) =>
  reconcileAsset(db(), {
    assetCode,
    chain: 'platform',
    network: 'testnet',
    tolerance,
    producer: 'ledger',
    ...(unobservedReason ? { unobservedReason } : {}),
  })

/**
 * An opening SHARD balance: custody up, the user's liability up, by the same amount.
 *
 * SHARD is the point of this file. It is the one asset with no chain behind it, which is what makes
 * `observed_source = 'liability_sum'` legal for it and illegal for every other — so these cases
 * cannot be re-denominated in EMBER without testing something else entirely.
 *
 * The kind is `adjustment` and NOT `deposit_credited`, which is what it used to be. SHARD is
 * retired, and migration 13 refuses an acquisition denominated in a retired asset —
 * `deposit_credited` among them, precisely because an asset with no chain cannot receive a deposit
 * from one. An opening balance in a platform unit is an adjustment; calling it a deposit was
 * always the wrong word, and the guard is what made the wrongness cost something.
 */
const shardBalance = (amount: bigint) =>
  depositEntry({ amount, assetCode: 'SHARD', kind: 'adjustment' })

/** The mirror, so a freeze can be shown to block a real withdrawal of a real holding. */
const shardWithdrawal = (amount: bigint, kind?: Parameters<typeof withdrawalEntry>[0]['kind']) =>
  withdrawalEntry({ amount, assetCode: 'SHARD', ...(kind ? { kind } : {}) })

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetLedger(sql)
})

/**
 * Mint a liability with no custody behind it.
 *
 * This is `convertCoinToEmber` in one entry: the user is credited and the counter-debit goes to a
 * clearing account instead of custody, so the platform now owes value it does not hold. It is a
 * perfectly balanced entry — which is exactly why the balancing invariant cannot catch it and
 * reconciliation must.
 */
async function mintUnbackedLiability(amount: bigint): Promise<void> {
  await post({
    kind: 'conversion',
    originatingService: 'pay',
    actor: 'system',
    correlationId: 'c-unbacked',
    idempotencyKey: freshKey(),
    description: 'credits a liability with no on-chain movement behind it',
    postings: [
      {
        account: { subject: 'clearing', assetCode: 'SHARD', purpose: 'suspense', type: 'clearing', overdraftAllowed: true },
        direction: 'debit',
        amount,
        assetCode: 'SHARD',
        sequence: 0,
      },
      { account: userAccount(ALICE, 'SHARD'), direction: 'credit', amount, assetCode: 'SHARD', sequence: 1 },
    ],
  })
}

/* ========================================================= the vacuous path (DEFECT) */

/**
 * **THE FINDING THIS COMMIT EXISTS FOR, WRITTEN AS A TEST THAT PASSED BEFORE IT.**
 *
 * `docs/ecosystem/00-current-state.md` records the sin the estate is migrating away from:
 * "Custodial EMBER can be minted with no chain movement." The owner's decision is that the
 * economics of the ecosystem must be **valid from chain**.
 *
 * The check that was supposed to hold that property could not fail. `reconcile.ts` read
 *
 *     observedSource = input.indexerObservedTotal !== undefined ? 'indexer' : 'liability_sum'
 *
 * and NO CALLER EVER SUPPLIED ONE. `jobs.ts` — the scheduled sweep, the only production
 * caller in the estate — passed `assetCode`, `chain`, `network`, `tolerance` and `producer`, and
 * nothing else. `grep -rn indexerObservedTotal ledger/src` found it set in exactly one place: a
 * test. So **every reconciliation this service has ever run in anger took the `liability_sum`
 * branch**, on EMBER as much as on SHARD.
 *
 * That branch is not useless — it catches `convertCoinToEmber`, a liability credited against no
 * custody position, and the test below it still proves that. But it is an INTERNAL identity: it
 * asks the ledger whether the ledger agrees with itself. It cannot see a chain, and the deposit
 * fabricated here moves BOTH sides at once, so the books balance perfectly about coin that does
 * not exist.
 *
 * The test asserts the same ledger state twice and gets two opposite verdicts. That is the whole
 * proof: if a verdict flips on evidence the run never demanded, the verdict was worth nothing.
 *
 * ## Worse than "proves nothing": it ERASED a true finding
 *
 * Written first with the pre-fix assertions and run green, which is how the following was found and
 * it was not in the plan. Ordering the two runs as they are ordered here — the honest one first —
 * the vacuous run that followed did not merely return a meaningless `clean`. Because `clean` is
 * exactly the status that lifts a freeze (`reconcile.ts`, and that asymmetry is correct), the
 * `liability_sum` run **deleted the `asset_freezes` row** the indexer-backed run had just written:
 *
 *     assert.equal(unobserved.unfroze, true)      // passed, before this commit
 *     assert.deepEqual(await listFreezes(db()), []) // passed, before this commit
 *
 * So on a schedule where a real observation arrived occasionally and the vacuous sweep ran every
 * interval, the sweep would reopen withdrawals on an asset a real check had frozen — and the last
 * word always belonged to the run that had looked at nothing. A check that cannot fail is bad; a
 * check that cannot fail and outranks the one that can is the defect that matters.
 */
test('THE DEFECT: a deposit that never happened on chain reconciles CLEAN with no observation', { skip }, async () => {
  // A fabricated deposit of an ON-CHAIN asset: custody is debited and the user credited, in one
  // balanced entry, with no transaction behind it on any chain. This is 00-current-state.md.
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  // What the chain actually holds. Nothing.
  const truth = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 0n,
  })
  assert.equal(truth.observedSource, 'indexer')
  assert.equal(truth.drift, '5000', 'the ledger claims 5000 EMBER the chain does not show')
  assert.equal(truth.status, 'drift_exceeded')
  assert.equal(truth.froze, true)

  // The identical ledger state, reconciled the way the scheduled job actually reconciled it.
  //
  // BEFORE THIS COMMIT this returned status 'clean', drift '0', observed_source 'liability_sum',
  // froze false — a green run over 5000 EMBER of thin air. AFTER it, the absence of an indexer
  // reading is itself the finding: no observation, no drift number, `failed`, and the asset stays
  // frozen. Absence of evidence must not read as evidence.
  //
  // The reason is NAMED since micro-org#275, and naming it is what keeps this case asserting what
  // it was written to assert. `indexer_error` is the estate's own honest answer for a chain nobody
  // follows — `chain_not_followed`, a 503 — and it is structural, so it freezes on the first run
  // exactly as every unobserved run used to. A transient reason is now deferred instead, which is
  // a different claim and is proved separately below.
  const unobserved = await run('EMBER', {}, 'indexer_error')

  assert.equal(unobserved.observedSource, 'unavailable')
  assert.equal(unobserved.indexerObservedTotal, null, 'an unknown must be recorded as unknown, never as 0')
  assert.equal(unobserved.drift, null, 'there is no drift to state without something to compare against')
  assert.equal(unobserved.status, 'failed')
  assert.equal(unobserved.ledgerCustodyTotal, '5000', 'the half we DO know is still recorded')

  // `freezesWithdrawals('failed')` is true, so an unobservable asset is a frozen asset.
  assert.equal(unobserved.unfroze, false, 'a run that observed nothing may never lift a freeze')
  const freezes = await listFreezes(db())
  assert.equal(freezes.length, 1)
  assert.equal(freezes[0]!.assetCode, 'EMBER')
  assert.match(freezes[0]!.reason, /no indexer observation/)
})

/* ================================================================== the invariant */

test('a ledger where custody equals liabilities reconciles clean', { skip }, async () => {
  await post(shardBalance(5_000n))

  const result = await run('SHARD')

  assert.equal(result.status, 'clean')
  assert.equal(result.drift, '0')
  assert.equal(result.ledgerCustodyTotal, '5000')
  assert.equal(result.indexerObservedTotal, '5000')
  assert.equal(result.observedSource, 'liability_sum')
  assert.equal(result.froze, false)

  // The run is recorded even when clean, so "when was this last checked" is answerable.
  const runs = await latestRuns(db())
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.status, 'clean')
})

test('THE DEFECT: a liability minted with no custody behind it is caught', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)

  const result = await run('SHARD')

  // Custody 5000, liabilities 6000. The ledger owes 1000 it does not hold.
  assert.equal(result.ledgerCustodyTotal, '5000')
  assert.equal(result.indexerObservedTotal, '6000')
  assert.equal(result.drift, '-1000', 'the sign carries the meaning and must not be discarded')
  assert.equal(result.status, 'drift_exceeded')
  assert.equal(result.froze, true)
})

test('drift inside tolerance is recorded but does NOT freeze', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(10n)

  const result = await run('SHARD', { SHARD: 100n })

  assert.equal(result.status, 'drift_within_tolerance')
  assert.equal(result.drift, '-10')
  assert.equal(result.froze, false)
  assert.deepEqual(await listFreezes(db()), [])
})

test('an asset with NO configured tolerance gets zero, not unlimited', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1n)

  // One unit of drift, no tolerance configured for SHARD. Failing closed is the whole point:
  // an asset silently exempt from the only check that guards it is the worst outcome.
  const result = await run('SHARD', { EMBER: 1_000_000n })
  assert.equal(result.status, 'drift_exceeded')
  assert.equal(result.froze, true)
})

/* ================================================================== the freeze */

test('THE FREEZE: a withdrawal is refused while the asset is frozen', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)
  assert.equal((await run('SHARD')).froze, true)

  // The whole mechanical consequence of reconciliation. Without this the drift alert is a log line.
  await assert.rejects(
    () => post(shardWithdrawal(100n, 'withdrawal_requested')),
    (err: unknown) => err instanceof AssetFrozenError && err.assetCode === 'SHARD',
  )
  await assert.rejects(
    () => post(shardWithdrawal(100n, 'withdrawal_settled')),
    AssetFrozenError,
  )
})

test('THE FREEZE: the refusal does not carry the estate’s custody position', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)
  assert.equal((await run('SHARD')).froze, true)

  // `Error.message` is what `server.ts` hands to `errorReply` for every refusal it classifies, so
  // anything interpolated into it is in the 409 body. `asset_freezes.reason` used to be, and that
  // string is the operator diagnostic: custody total, observed total, drift, and a per-bucket
  // breakdown with address counts — the platform's treasury position, returned to whoever asked to
  // withdraw (micro-org#314). The detail is still on `.reason`, which is where the log line and
  // `GET /reconciliation` read it from; this test is about the one field that travels outward.
  //
  // Asserted on the STRUCTURE and not on the exact sentence: the numbers here are this fixture's,
  // and a future edit to the reason string must not be able to reintroduce the disclosure.
  const err = await post(shardWithdrawal(100n, 'withdrawal_requested')).then(
    () => assert.fail('the withdrawal must be refused'),
    (e: unknown) => e as AssetFrozenError,
  )
  assert.ok(err instanceof AssetFrozenError)
  for (const forbidden of [/custody/i, /observed/i, /drift/i, /\d+\s+address/i, /\d{3,}/]) {
    assert.doesNotMatch(err.message, forbidden, `message leaks ${forbidden}: ${err.message}`)
  }
  // …and the detail is still available to the operator on the property.
  assert.match(err.reason, /custody/i)
})

test('THE FREEZE: deposits and refunds are NOT blocked', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)
  await run('SHARD')

  // The freeze stops value LEAVING the platform. Blocking a deposit would strand incoming money;
  // blocking a refund would harm the party the freeze exists to protect.
  await assert.doesNotReject(() => post(shardBalance(100n)))
  await assert.doesNotReject(() =>
    post(shardWithdrawal(100n, 'withdrawal_refunded')),
  )
})

test('THE FREEZE: another asset is unaffected', { skip }, async () => {
  await post(shardBalance(5_000n))
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))
  await mintUnbackedLiability(1_000n)
  await run('SHARD')

  // A freeze is per asset. One drifting asset must not stop the whole platform paying out.
  await assert.doesNotReject(() =>
    post(withdrawalEntry({ amount: 100n, assetCode: 'EMBER', kind: 'withdrawal_requested' })),
  )
})

test('a freeze is lifted only by an exactly-clean run, never by one merely within tolerance', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)
  assert.equal((await run('SHARD')).froze, true)

  // Still drifting, but now inside a generous tolerance. The bar to LIFT is higher than the bar
  // that set it, so an asset near the boundary cannot flap in and out of frozen on every run.
  const withinTolerance = await run('SHARD', { SHARD: 5_000n })
  assert.equal(withinTolerance.status, 'drift_within_tolerance')
  assert.equal(withinTolerance.unfroze, false)
  assert.equal((await listFreezes(db())).length, 1, 'the freeze must persist')
  await assert.rejects(() => post(shardWithdrawal(10n)), AssetFrozenError)

  // Correct the drift properly: move the unbacked amount into custody.
  await post({
    kind: 'reconciliation_correction',
    originatingService: 'ops',
    actor: 'operator:1',
    correlationId: 'c-fix',
    idempotencyKey: freshKey(),
    postings: [
      { account: custodyAccount('SHARD'), direction: 'debit', amount: 1_000n, assetCode: 'SHARD', sequence: 0 },
      {
        account: { subject: 'clearing', assetCode: 'SHARD', purpose: 'suspense', type: 'clearing', overdraftAllowed: true },
        direction: 'credit',
        amount: 1_000n,
        assetCode: 'SHARD',
        sequence: 1,
      },
    ],
  })

  const clean = await run('SHARD')
  assert.equal(clean.status, 'clean')
  assert.equal(clean.unfroze, true)
  assert.deepEqual(await listFreezes(db()), [])
  await assert.doesNotReject(() => post(shardWithdrawal(10n)))
})

test('a freeze records the run that caused it, and refreshes on the latest run', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)

  const first = await run('SHARD')
  const freezes = await listFreezes(db())
  assert.equal(freezes.length, 1)
  assert.equal(freezes[0]!.runId, first.id, 'an operator must be able to read the arithmetic')
  assert.match(freezes[0]!.reason, /drift -1000/)

  // A second, worse run must refresh the reason rather than leave the superseded one in place.
  await mintUnbackedLiability(500n)
  const second = await run('SHARD')
  const refreshed = await listFreezes(db())
  assert.equal(refreshed[0]!.runId, second.id)
  assert.match(refreshed[0]!.reason, /drift -1500/)
})

/* ================================================================== the indexer half */

test('an indexer-supplied total is compared and labelled as such', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  // The other half of the invariant, wired in when AD-07 lands. A positive drift here means the
  // ledger believes we hold coin the chain does not show — the dangerous direction.
  const result = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 4_900n,
  })

  assert.equal(result.observedSource, 'indexer')
  assert.equal(result.ledgerCustodyTotal, '5000')
  assert.equal(result.indexerObservedTotal, '4900')
  assert.equal(result.drift, '100')
  assert.equal(result.status, 'drift_exceeded')
})

test('the drift freeze names WHERE the observed side sits, when the observer said', { skip }, async () => {
  // Step 5 of micro-org#248. "drift 100" says the estate and the chain disagree; it does not say
  // whether users' deposits are short or the platform's own float is, which are different incidents
  // with different code behind them. The clause is APPENDED, so the arithmetic an operator can
  // check reads exactly as it did before this change and the reported split follows it.
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))
  const result = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 4_900n,
    observedBreakdown: 'deposit: 4000 over 12 addresses, treasury: 900 over 1 address',
  })

  const [freeze] = await listFreezes(db())
  assert.equal(freeze?.runId, result.id)
  assert.equal(
    freeze?.reason,
    'reconciliation drift_exceeded: drift 100 (custody 5000, observed 4900 = ' +
      'deposit: 4000 over 12 addresses, treasury: 900 over 1 address)',
  )
  // And the arithmetic itself is untouched by it: the breakdown is prose in one column and reaches
  // neither the drift, the status, nor the run row.
  assert.equal(result.drift, '100')
  assert.equal(result.status, 'drift_exceeded')
})

test('no breakdown means no clause, because an empty split would be a claim about the chain', { skip }, async () => {
  // An indexer older than this release sends no split. The freeze must read as it always did rather
  // than trailing an `=` with nothing after it, which an operator would read as "the chain holds
  // nothing anywhere" — a measurement, where the truth is that nobody reported one.
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))
  await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 4_900n,
  })
  const [freeze] = await listFreezes(db())
  assert.equal(freeze?.reason, 'reconciliation drift_exceeded: drift 100 (custody 5000, observed 4900)')
})

test('a breakdown longer than a freeze message is clamped, and says that it was', { skip }, async () => {
  // The second clamp, on a value the client has already bounded. `reconcileAsset` is callable by
  // more than the HTTP client, and "a freeze reason is a bounded string" should be true of every
  // caller rather than of one producer.
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))
  await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 4_900n,
    observedBreakdown: 'x'.repeat(5_000),
  })
  const [freeze] = await listFreezes(db())
  assert.ok(freeze !== undefined && freeze.reason.length < 400, `unbounded reason`)
  assert.match(freeze.reason, /…\)$/)
  // The arithmetic still precedes it and is still readable, which is the point of appending.
  assert.match(freeze.reason, /^reconciliation drift_exceeded: drift 100 \(custody 5000, observed 4900 = x/)
})

/**
 * **The seductive case, and the one this test used to get wrong.**
 *
 * It asserted that EMBER with no accounts "reconciles clean at zero", and the reasoning felt
 * obvious: there is nothing there, so there is nothing to be wrong about. It is not obvious and it
 * is not true. "Our custody is zero" is still a CLAIM about a chain, and the run that made it had
 * not looked at one — it had asked this ledger's liability accounts, found them empty too, and
 * subtracted zero from zero. Two numbers from the same empty table agreeing is not evidence.
 *
 * Kept as a test because the empty case is exactly where a vacuous check hides best: it produces
 * the tidiest possible green.
 */
test('an on-chain asset with no accounts is NOT clean — nobody asked the chain', { skip }, async () => {
  const result = await run('EMBER')

  assert.equal(result.status, 'failed')
  assert.equal(result.observedSource, 'unavailable')
  assert.equal(result.ledgerCustodyTotal, '0')
  assert.equal(result.drift, null, '0 - 0 = 0 was never a measurement')
})

test('an on-chain asset OBSERVED at zero is clean, and that is a different fact', { skip }, async () => {
  // The same ledger state as above, plus the one thing that was missing: somebody looked.
  const result = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 0n,
  })
  assert.equal(result.status, 'clean')
  assert.equal(result.observedSource, 'indexer')
  assert.equal(result.drift, '0')
})

test('a PLATFORM asset with no accounts still reconciles clean at zero', { skip }, async () => {
  // SHARD is absent from ON_CHAIN_ASSETS and has no chain to observe, so the internal identity is
  // the only check available and it remains a real one. This commit must not have broken it by
  // demanding a feed that can never exist.
  const result = await run('SHARD')
  assert.equal(result.status, 'clean')
  assert.equal(result.observedSource, 'liability_sum')
  assert.equal(result.ledgerCustodyTotal, '0')
  assert.equal(result.drift, '0')
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * micro-org#275 — A ROLLING RESTART MUST NOT FREEZE A HEALTHY ASSET
 *
 * Restarting `indexer` and `identity` on mainnet at 2026-08-08 23:23 UTC put the EMBER sweep
 * inside the window at 23:23:28. It could not mint a service token, recorded `no_credential`, and
 * froze an asset nothing was wrong with; the 23:38:29 sweep was clean and lifted it. Fifteen
 * minutes of refused withdrawals, caused by maintenance, and repeatable on any deploy that touches
 * identity — which is most of them.
 *
 * Every case below is about WHEN a verdict is reached. **Not one of them relaxes what is compared:**
 * an unobserved run still records a NULL total, a NULL drift and `failed`, still cannot be clean,
 * and still cannot lift a freeze. That is asserted in each case rather than assumed, because the
 * way this change could go wrong is by buying quiet with a number nobody measured.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** What must be true of every deferred run, so no case below can quietly assert less. */
function assertStillUnobserved(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.observedSource, 'unavailable')
  assert.equal(result.status, 'failed', 'a run that observed nothing may never be clean')
  assert.equal(result.indexerObservedTotal, null, 'nothing is not zero')
  assert.equal(result.drift, null, 'there is no drift without two numbers to subtract')
  assert.equal(result.unfroze, false, 'an unobserved run may never lift a freeze')
}

test('a TRANSIENT absence does not freeze on the first run — a restart is not an insolvency', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  // The exact row mainnet wrote at 23:23:28. Nothing is known about EMBER's backing in either
  // direction, and the state of the world a moment earlier — clean, drift 0 — is unchanged.
  const result = await run('EMBER', {}, 'no_credential')

  assertStillUnobserved(result)
  assert.equal(result.froze, false, 'a single restart window froze a healthy asset')
  assert.equal(result.freezeDeferred, true)
  assert.equal(result.unobservedRuns, 1)
  assert.deepEqual(await listFreezes(db()), [], 'withdrawals must still be open')
})

test('a TRANSIENT absence that persists freezes on the next run — the guarantee still holds', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  const deferred = await run('EMBER', {}, 'no_credential')
  assert.equal(deferred.froze, false)

  // Fifteen minutes later and still nobody can look. That is no longer a deploy window, it is an
  // observer that is broken, and an asset whose backing nobody can see is an asset nobody should
  // be able to withdraw.
  const frozen = await run('EMBER', {}, 'no_credential')

  assertStillUnobserved(frozen)
  assert.equal(frozen.unobservedRuns, UNOBSERVED_RUNS_BEFORE_FREEZE)
  assert.equal(frozen.freezeDeferred, false)
  assert.equal(frozen.froze, true)
  const [freeze] = await listFreezes(db())
  assert.ok(freeze, 'a persistent absence must still freeze')
  assert.match(freeze.reason, /no indexer observation/)
  // The freeze still refuses to imply a zero, and still names its own cause.
  assert.match(freeze.reason, /chain holdings UNKNOWN, not zero/)
  assert.match(freeze.reason, /reason no_credential/)
})

test('a STRUCTURAL absence freezes on the FIRST run — the deploy trap must keep working', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  // `not_configured` is a deployment with no INDEXER_URL: nothing was dialled, and waiting will not
  // dial it. The deploy compose comments document this freeze deliberately, and micro-org#275 asks
  // for it to keep firing promptly while the transient reasons stop doing so.
  const result = await run('EMBER', {}, 'not_configured')

  assertStillUnobserved(result)
  assert.equal(result.freezeDeferred, false)
  assert.equal(result.froze, true, 'a structural absence was deferred like a blip')
  assert.equal(result.unobservedRuns, 1, 'it froze on the first run, not after a wait')
})

test('an observed run RESETS the count, so two blips a week apart never freeze', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  assert.equal((await run('EMBER', {}, 'unreachable')).freezeDeferred, true)

  // A real reading of a real chain, agreeing exactly. The estate is demonstrably solvent at this
  // moment, so the previous failure is spent evidence and must not be carried forward.
  const observed = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 5_000n,
  })
  assert.equal(observed.status, 'clean')
  assert.equal(observed.unobservedRuns, null, 'a run that observed has no absence to count')
  assert.equal(observed.freezeDeferred, false)

  const second = await run('EMBER', {}, 'unreachable')
  assert.equal(second.unobservedRuns, 1, 'the count must be CONSECUTIVE, not cumulative')
  assert.equal(second.freezeDeferred, true)
  assert.deepEqual(await listFreezes(db()), [])
})

test('a deferred run leaves an existing freeze exactly as it found it', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))

  // A measured drift. This freezes on the first run and always has — deferral is about absence,
  // never about arithmetic somebody actually did.
  const drifted = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 4_000n,
  })
  assert.equal(drifted.froze, true)
  assert.equal(drifted.freezeDeferred, false, 'a drift is never deferred')
  const before = (await listFreezes(db()))[0]!

  const deferred = await run('EMBER', {}, 'timeout')
  assert.equal(deferred.freezeDeferred, true)

  const after = (await listFreezes(db()))[0]!
  assert.equal(after.reason, before.reason, 'a blip overwrote the arithmetic of a real freeze')
  assert.equal(after.runId, before.runId)
  assert.match(after.reason, /drift 1000/, 'the operator must still see the number they can check')
  // The asset is still frozen. Nothing about deferral reopens a withdrawal path.
  assert.equal((await listFreezes(db())).length, 1)
})

test('the deferred state is ON THE WIRE, not left to a consumer to infer', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))
  const result = await run('EMBER', {}, 'no_credential')

  const row = (await outboxRows(RECONCILIATION_COMPLETED))[0]!
  // `froze: false` beside a non-null reason used to be impossible. It is now the ordinary shape of
  // a deploy window, and a subscriber reading the pair as "nothing to see" would be wrong in the
  // one direction that matters — so the third state is stated.
  assert.equal(row.payload['froze'], false)
  assert.equal(row.payload['unobservedReason'], 'no_credential')
  assert.equal(row.payload['freezeDeferred'], true)
  assert.equal(row.payload['unobservedRuns'], 1)
  // And it survives JSON, where an `undefined` would become an absent key every reader treats as
  // false — the same laundering `drift: null` exists to prevent, two fields over.
  const built = buildEnvelope(row)
  assert.ok(built.ok, 'the relay would refuse the envelope built from a deferred run')
  const delivered = JSON.parse(JSON.stringify(built.value)) as {
    payload: Record<string, unknown>
  }
  assert.ok(Object.hasOwn(delivered.payload, 'freezeDeferred'))
  assert.equal(delivered.payload['freezeDeferred'], true)
  assert.equal(delivered.payload['drift'], null, 'nothing is still not zero, on the wire')
  assert.equal(result.id, row.payload['runId'])
})

test('EVERY reason has a persistence, and the split is the one the client already draws', { skip: false }, () => {
  // A total Record, so a ninth reason cannot be added without deciding. Enumerated from
  // `UNOBSERVED_REASONS` rather than from the object's own keys — reading the map to check the map
  // is the shape of assertion that passes whatever is in it.
  for (const reason of UNOBSERVED_REASONS) {
    assert.ok(
      UNOBSERVED_PERSISTENCE[reason] === 'transient' || UNOBSERVED_PERSISTENCE[reason] === 'structural',
      `${reason} has no persistence, so reconciliation cannot decide when to act on it`,
    )
  }

  // The split is not new vocabulary: `indexerclient.ts` already says "`no_credential` and
  // `unauthorized` are faults in THIS platform's authentication. `indexer_error` is the indexer
  // saying it cannot see the chain." Pinned as a literal set because moving a reason across this
  // line changes when the estate stops paying people, and that must never be a quiet edit.
  assert.deepEqual(
    UNOBSERVED_REASONS.filter(isTransientUnobserved),
    ['no_credential', 'unauthorized', 'timeout', 'unreachable'],
  )
  // `chain_not_followed` — the expected freeze for an unlaunched chain — arrives as `indexer_error`
  // and must stay on the structural side, or the trap the deploy comments document stops working.
  assert.equal(isTransientUnobserved('indexer_error'), false)
  assert.equal(isTransientUnobserved('not_configured'), false)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * micro-org#248 FIX B — WHY PLATFORM EQUITY IS *NOT* NETTED OUT, RECORDED AS A TEST
 *
 * #248 offered two fixes and expected them to compose. **They do not**, and the arithmetic is not
 * subtle once both are written down. Fix A shipped in `settlement/src/treasury.ts`: registering a
 * treasury with the indexer now also posts an opening entry DEBITING custody and CREDITING platform
 * equity for that address's balance. Balances are stored in each account's normal direction
 * (`entries.ts increasesBalance`), so after A the float is a positive number in BOTH the custody
 * asset total and the platform equity total — and the indexer's observed total counts the treasury
 * address too, because sweeps move customer coin into it and un-watching it would blind the check.
 *
 * Both sides therefore already count the same coin. Netting equity off the ledger side would remove
 * the float from one side of a comparison that has it on both.
 *
 * Measured on the live mainnet ledger, 2026-08-09:
 *
 *     custody   asset  available EMBER  25100000000000000000
 *     platform  equity treasury  EMBER  25000020999999996000
 *     latest run: indexer, observed 25100000000000000000, drift 0, clean
 *
 * `custody − equity` is `99979000000004000`, against an observed `25100000000000000000` — a drift
 * of the entire platform float, `drift_exceeded`, and EMBER withdrawals stopped estate-wide on
 * deploy. The design note on #248 reached the same conclusion in prose ("not doing: netting equity
 * out of the comparison — arithmetically equivalent only while the equity account is correct");
 * this is that conclusion as something that fails if anyone implements it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('a booked treasury float reconciles clean, and netting it out would be the drift', { skip }, async () => {
  // The shape settlement's `registerTreasuryWithIndexer` writes: custody up, platform equity up,
  // one balanced entry, for coin the platform owns with no customer behind it.
  await post({
    kind: 'adjustment',
    originatingService: 'settlement',
    actor: 'system',
    correlationId: `corr-${freshKey()}`,
    idempotencyKey: freshKey('opening'),
    postings: [
      {
        account: { subject: 'custody', assetCode: 'EMBER', purpose: 'available', type: 'asset' },
        direction: 'debit',
        amount: 25_000n,
        assetCode: 'EMBER',
        sequence: 0,
      },
      {
        account: { subject: 'platform', assetCode: 'EMBER', purpose: 'treasury', type: 'equity' },
        direction: 'credit',
        amount: 25_000n,
        assetCode: 'EMBER',
        sequence: 1,
      },
    ],
  })
  // And a customer deposit beside it, so the two are distinguishable rather than one number.
  await post(depositEntry({ amount: 100n, assetCode: 'EMBER' }))

  // The chain holds both: the treasury address and the deposit addresses are all in the indexer's
  // custody set.
  const result = await reconcileAsset(db(), {
    producer: 'ledger',
    assetCode: 'EMBER',
    chain: 'Hearth',
    network: 'testnet',
    tolerance: {},
    indexerObservedTotal: 25_100n,
  })

  assert.equal(result.ledgerCustodyTotal, '25100', 'the custody total must include the booked float')
  assert.equal(result.drift, '0')
  assert.equal(result.status, 'clean')
  assert.deepEqual(await listFreezes(db()), [])

  // What Fix B as written in #248 would have compared, computed here rather than shipped. If a
  // future change nets equity out of `custodyTotal`, the assertion above goes red and this one
  // explains why — a drift of exactly the platform float, on an estate that is provably solvent.
  const equity = await sql<{ total: string }[]>`
    select coalesce(sum(b.amount), 0)::text as total
      from balances b join accounts a on a.id = b.account_id
     where a.type = 'equity' and a.subject = 'platform' and b.asset_code = 'EMBER'
  `
  assert.equal(equity[0]!.total, '25000')
  assert.equal(
    BigInt(result.ledgerCustodyTotal) - BigInt(equity[0]!.total) - 25_100n,
    -25_000n,
    'netting platform equity out of the ledger side invents a drift of the whole float',
  )
})

/* ====================================================== the schema, not the handler */

/**
 * **Every test in this section goes around `reconcileAsset` entirely.**
 *
 * That is the whole point of putting the rule in the schema. A guard that lives only in the handler
 * is bypassed by a bug in the handler, by a later migration, or by an operator with a psql
 * connection — and the third is not hypothetical, it is how a stuck reconciliation gets "fixed" at
 * 3am. These insert raw rows the way `psql` would, and assert the database refuses them.
 *
 * `23514` is `check_violation`. The trigger raises it explicitly so a caller cannot tell the
 * table-reading rule from the CHECK-expressible ones, and does not need to.
 */
const CHECK_VIOLATION = '23514'

/** A raw run row, bypassing every line of `reconcile.ts`. Overridable field by field. */
async function rawRun(fields: Record<string, unknown>): Promise<void> {
  const row = {
    chain: 'Hearth',
    network: 'testnet',
    asset_code: 'EMBER',
    ledger_custody_total: '5000',
    indexer_observed_total: '5000',
    drift: '0',
    status: 'clean',
    observed_source: 'indexer',
    ...fields,
  }
  await sql`insert into reconciliation_runs ${sql(row as never)}`
}

async function refuses(fields: Record<string, unknown>, constraint: RegExp): Promise<void> {
  await assert.rejects(
    () => rawRun(fields),
    (err: unknown) => {
      const e = err as { code?: string; message?: string; constraint_name?: string }
      assert.equal(e.code, CHECK_VIOLATION, `expected a check violation, got ${e.code}: ${e.message}`)
      assert.match(`${e.constraint_name ?? ''} ${e.message ?? ''}`, constraint)
      return true
    },
  )
}

test('SCHEMA: an on-chain asset may not be attested by the ledger’s own books', { skip }, async () => {
  // The exact row every scheduled run wrote before this commit, offered directly to Postgres.
  await refuses(
    { asset_code: 'EMBER', observed_source: 'liability_sum' },
    /may not use observed_source=liability_sum/,
  )
  // Not just EMBER. Every asset the estate declares as chain-settled.
  for (const asset of ON_CHAIN_ASSETS) {
    await refuses({ asset_code: asset, observed_source: 'liability_sum' }, /liability_sum/)
  }
})

test('SCHEMA: the trigger covers UPDATE, so a run cannot be relabelled after the fact', { skip }, async () => {
  await rawRun({ asset_code: 'EMBER', observed_source: 'indexer' })
  // `update ... set observed_source = 'liability_sum'` would launder a failed run into a checked
  // one without inserting anything. BEFORE INSERT alone would have missed this entirely.
  await assert.rejects(
    () => sql`update reconciliation_runs set observed_source = 'liability_sum' where asset_code = 'EMBER'`,
    (err: unknown) => (err as { code?: string }).code === CHECK_VIOLATION,
  )
})

test('SCHEMA: a platform asset is NOT caught by the chain rule', { skip }, async () => {
  // The guard must refuse the vacuous case without refusing the legitimate one. SHARD has no chain,
  // so `liability_sum` is correct for it and must remain insertable.
  await assert.doesNotReject(() =>
    rawRun({ asset_code: 'SHARD', chain: 'platform', observed_source: 'liability_sum' }),
  )
})

/**
 * An unobserved row, complete under migration 12.
 *
 * `unobserved_reason` belongs to the fixture rather than to each case, so the tests below still
 * fail for the constraint they NAME. Without it every one of them would trip
 * `reconciliation_runs_reason_chk` first and pass while proving nothing about the rule it was
 * written for — a suite going green on the wrong constraint, which is precisely the failure this
 * area of the schema exists to prevent.
 */
const unobserved = {
  observed_source: 'unavailable',
  indexer_observed_total: null,
  drift: null,
  unobserved_reason: 'indexer_error',
}

test('SCHEMA: an unobserved run may not be clean — absence of evidence is not evidence', { skip }, async () => {
  for (const status of ['clean', 'drift_within_tolerance', 'drift_exceeded']) {
    await refuses({ ...unobserved, status }, /unobserved_failed/)
  }
  // `failed` is the only status it may carry, and it must remain insertable.
  await assert.doesNotReject(() => rawRun({ ...unobserved, status: 'failed' }))
})

test('SCHEMA: an unknown is recorded as unknown, and may not be laundered into a zero', { skip }, async () => {
  // The defect this release removes, in its purest form: no observation, written down as 0.
  await refuses({ ...unobserved, indexer_observed_total: '0', drift: '0', status: 'failed' }, /unobserved_chk/)
  // And the mirror — a NULL total under a source that claims one was obtained.
  await refuses({ observed_source: 'indexer', indexer_observed_total: null, drift: null }, /unobserved_chk/)
  // A drift stated beside an absent observation: 0 − nothing is not 0.
  await refuses({ ...unobserved, drift: '0', status: 'failed' }, /drift_chk/)
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * MIGRATION 12 — AN UNOBSERVED RUN MUST SAY WHY.
 *
 * Migration 11 made "nobody observed this" recordable and every column above is correct. What it
 * could not record is the difference between an unlaunched chain — EMBER's honest, expected state
 * — and this service failing to authenticate, which is what actually happened for the life of the
 * service: a 600-second token read once at boot, inside a job that runs every 900 seconds. Both
 * wrote `unavailable` / NULL / NULL / `failed`. One of them is a page.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('SCHEMA: an unobserved run must state a reason — the freeze that could not be read', { skip }, async () => {
  await refuses({ ...unobserved, unobserved_reason: null, status: 'failed' }, /reason_chk/)

  // The mirror, and it is not decoration. A run that DID observe may not carry a reason: a row
  // asserting both "the indexer answered" and "nobody could authenticate" is one a dashboard would
  // render either way round, and whichever it chose would be wrong half the time.
  await refuses({ observed_source: 'indexer', unobserved_reason: 'no_credential' }, /reason_chk/)
  await refuses(
    {
      asset_code: 'SHARD',
      chain: 'platform',
      observed_source: 'liability_sum',
      unobserved_reason: 'timeout',
    },
    /reason_chk/,
  )
})

test('SCHEMA: the reason is a token, never a message an error carried', { skip }, async () => {
  // The column is read by dashboards and is interpolated into `asset_freezes.reason`, which is
  // served over HTTP by GET /reconciliation. A raw error message reaching it could carry a URL, a
  // query string or a bearer — so the SHAPE is constrained even though the vocabulary deliberately
  // is not (migration 12 argues why).
  for (const bad of [
    'could not exchange the service credential: identity refused 401',
    'HTTP://INDEXER:4000/v1/custody?token=abc',
    'no',
    '',
    'a_reason_far_longer_than_the_thirty_two_characters_allowed',
  ]) {
    await refuses({ ...unobserved, unobserved_reason: bad, status: 'failed' }, /reason_shape_chk/)
  }

  // And every member of the union `indexerclient.ts` can actually produce is accepted, so the shape
  // rule can never refuse a diagnosis this service is capable of making — which would abort the
  // reconciliation transaction and dead-letter the estate's solvency check.
  for (const reason of UNOBSERVED_REASONS) {
    await assert.doesNotReject(
      () => rawRun({ ...unobserved, unobserved_reason: reason, status: 'failed' }),
      `the schema refuses ${reason}, which indexerclient.ts can produce`,
    )
  }
})

/**
 * **The one copy this design could not avoid, kept honest by this test.**
 *
 * A CHECK cannot reference another table and migration text is checksummed, so the on-chain list
 * had to exist a second time as rows in `chain_assets` (migrations.ts, version 11). A second list
 * is exactly the kind of thing that drifts in silence, so it gets a test that names the drift.
 *
 * If this fails, do NOT edit migration 11 — `@cloudsforge/db` refuses a changed migration by
 * checksum, and rightly. Add a new one that inserts or deletes the row.
 */
test('SCHEMA: chain_assets is exactly ON_CHAIN_ASSETS, or this whole guard is aimed wrong', { skip }, async () => {
  const rows = await sql<{ asset_code: string }[]>`select asset_code from chain_assets order by asset_code`
  assert.deepEqual(
    rows.map((r) => r.asset_code),
    [...ON_CHAIN_ASSETS].sort(),
    'contracts/packages/chain/src/index.ts:123 and migration 11 disagree about which assets live on a chain',
  )
  // SHARD named explicitly: contracts-chain carries it in CHAINS with the comment "never used on
  // chain", so `isChainAsset` returns TRUE for it. Using that predicate instead of this list would
  // demand an indexer feed for Shards and freeze them permanently, and it would look like a
  // working guard the entire time.
  assert.ok(!rows.some((r) => r.asset_code === 'SHARD'))
})

/* ================================================================== the announcement */

/**
 * **A COMPLETED RECONCILIATION TOLD NOBODY, FOR THE LIFE OF THIS SERVICE.**
 *
 * `ledger.reconciliation.completed` was registered with `producer: 'ledger'` before the service
 * existed. `activity/src/classify.ts` classifies it as `wallet.reconciliation_completed` and
 * reads `drift` off the payload; `analytics/src/catalogue.ts` records it, deliberately
 * impersonal, "kept because a reconciliation freeze explains a hole in every funnel that week";
 * `notify/src/catalogue.ts` files it under NON_NOTIFYING_TOPICS with a written reason — no
 * individual user is its subject — which is a decision rather than a gap. `server.ts` already
 * serves `GET /reconciliation`, and `docs/ecosystem/05-user-journeys.md` J14 is an operator
 * responding to a drift alert.
 *
 * The literal appeared nowhere in `ledger/src`. Two of those three consumers were dead code, and the
 * only way an operator could learn a run had finished was to poll.
 *
 * These tests run the REAL job against a REAL database and read the row it wrote. They are the
 * end-to-end half of `topics.test.ts`, which checks the same envelope against a fixture: a fixture
 * proves the builder is right, a real row proves the emit happened at all — and "the emit never
 * happened" is precisely the defect being closed.
 */

interface StoredOutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

const outboxRows = async (topic: string): Promise<StoredOutboxRow[]> =>
  sql<StoredOutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox where topic = ${topic} order by occurred_at
  `

test('THE FIX: a completed reconciliation announces itself, keyed the registry’s way', { skip }, async () => {
  await post(shardBalance(5_000n))
  const result = await run('SHARD')

  const rows = await outboxRows(RECONCILIATION_COMPLETED)
  assert.equal(rows.length, 1, 'a reconciliation that finishes and tells nobody is the defect')
  const row = rows[0]!

  // The registry's `keyedBy` is `chain:network`, and the key is the ordering partition — so it is
  // contract rather than a producer's preference. The ASSET is the obvious wrong answer here: it
  // would give every asset its own partition and lose the ordering between a freeze on one asset and
  // the run that lifted it on another.
  assert.equal(row.key, 'platform:testnet')
  assert.equal(KEYED_BY[RECONCILIATION_COMPLETED], 'chain:network')
  assert.equal(topicSpec(RECONCILIATION_COMPLETED).keyedBy, 'chain:network')

  // Both columns really are null on a real emit — this is a leased job with no principal and no
  // inbound request behind it — which is why `buildEnvelope` has to map them.
  assert.equal(row.actor, null)
  assert.equal(row.correlation_id, null)

  // Every number is a STRING. These are numeric(78,0) and routinely exceed 2^53; a JSON number would
  // round them, and rounding the two sides of a reconciliation by different amounts invents the
  // exact drift this job exists to detect.
  assert.equal(row.payload['drift'], '0')
  assert.equal(row.payload['ledgerCustodyTotal'], '5000')
  assert.equal(row.payload['indexerObservedTotal'], '5000')
  assert.equal(typeof row.payload['drift'], 'string')
  assert.equal(row.payload['status'], 'clean')
  assert.equal(row.payload['assetCode'], 'SHARD')
  assert.equal(row.payload['observedSource'], 'liability_sum')
  assert.equal(row.payload['runId'], result.id)
})

test('THE READER: activity can read the drift off a real event, and a freeze is on the wire', { skip }, async () => {
  await post(shardBalance(5_000n))
  await mintUnbackedLiability(1_000n)
  const result = await run('SHARD')
  assert.equal(result.froze, true, 'the fixture must actually freeze, or this asserts nothing')

  const row = (await outboxRows(RECONCILIATION_COMPLETED))[0]!
  const built = buildEnvelope(row)
  assert.ok(built.ok, 'the relay would refuse the envelope it built from a real reconciliation')

  // THE round trip. A field assigned `undefined` is indistinguishable from an absent one after JSON,
  // which is exactly how "the payload has a drift" can be true in a test and false on the wire.
  const delivered = JSON.parse(JSON.stringify(built.value)) as {
    actor: string
    correlationId: string
    version: string
    payload: Record<string, unknown>
  }
  assert.deepEqual(
    envelopeDefects(delivered),
    [],
    'a real reconciliation would be refused at the envelope by every consumer in the estate',
  )
  assert.equal(delivered.version, '1.0')
  assert.equal(delivered.actor, 'system')
  assert.equal(delivered.correlationId, row.id)

  // `activity/src/classify.ts` renders "Reconciliation completed with drift <drift>" and reads
  // the field by that name. An absent field would render the bare sentence and the operator would
  // never learn a number — the "absent is null to every reader" trap, so it is asserted present and
  // asserted to be the RIGHT number rather than merely a number.
  assert.equal(delivered.payload['drift'], '-1000')

  // The two facts an operator acts on, as booleans on the wire rather than inferred from `status`.
  // JSON drops `undefined`, and every reader then sees the safe-looking `false`.
  assert.ok(Object.hasOwn(delivered.payload, 'froze'))
  assert.ok(Object.hasOwn(delivered.payload, 'unfroze'))
  assert.equal(delivered.payload['froze'], true, 'withdrawals just stopped, and the event says so')
  assert.equal(delivered.payload['unfroze'], false)
  assert.equal(delivered.payload['status'], 'drift_exceeded')
})

test('the event and the run row commit together, or neither does', { skip }, async () => {
  // Rule 5 of docs/ecosystem/03 §2. Emitting after commit drops the event when the process dies in
  // the gap — and the event this would drop is the one saying withdrawals just stopped.
  await post(shardBalance(5_000n))
  await run('SHARD')
  const runs = await latestRuns(db())
  const events = await outboxRows(RECONCILIATION_COMPLETED)
  assert.equal(runs.length, events.length, 'one run, one announcement')
  assert.equal(events[0]!.payload['runId'], runs[0]!.id, 'and it names the run it describes')

  // A second run announces itself too: the topic is not a first-time-only event, and an operator
  // asking "did last night's run finish" needs every run, not the first.
  await run('SHARD')
  assert.equal((await outboxRows(RECONCILIATION_COMPLETED)).length, 2)
})

test('the two totals are read in ONE snapshot, so a concurrent posting cannot invent drift', { skip }, async () => {
  // They were two statements outside any transaction. A posting landing between them was counted on
  // one side and not the other — a phantom drift from a ledger that balances perfectly — and drift
  // beyond tolerance FREEZES WITHDRAWALS. That is a service that stops paying people because two
  // SELECTs disagreed.
  //
  // The race itself is not reproducible from here without controlling statement interleaving, so
  // what is asserted is the property that makes it impossible: the whole run is one transaction, so
  // a failure part-way leaves neither a run row nor an event.
  await post(shardBalance(5_000n))
  const before = (await latestRuns(db())).length
  await assert.rejects(
    () =>
      reconcileAsset(db(), {
        producer: 'ledger',
        // A code the tolerance table and the balances query both accept, with a chain name that
        // violates the run row's own check constraint — so the INSERT fails after the reads.
        assetCode: 'SHARD',
        chain: 'platform',
        network: 'nonsense' as 'testnet',
        tolerance: {},
      }),
    /reconciliation_runs|check constraint|invalid/i,
  )
  assert.equal((await latestRuns(db())).length, before, 'no run row survived the failure')
  assert.equal((await outboxRows(RECONCILIATION_COMPLETED)).length, 0, 'and no event did either')
})
