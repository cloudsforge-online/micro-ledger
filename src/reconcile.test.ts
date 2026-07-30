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
import { listFreezes, latestRuns, reconcileAsset } from './reconcile.ts'
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
import type { Db } from './outbox.ts'

let sql: postgres.Sql
const db = () => sql as unknown as Db
const deps = (): PostEntryDeps => ({ sql: db(), producer: 'ledger' })
const post = (request: Parameters<typeof postEntry>[1]) =>
  postEntry(deps(), request, requestFingerprint(request as unknown))

const run = (assetCode: 'SHARD' | 'EMBER', tolerance: Record<string, bigint> = {}) =>
  reconcileAsset(db(), { assetCode, chain: 'platform', network: 'testnet', tolerance })

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
      { account: userAccount(ALICE), direction: 'credit', amount, assetCode: 'SHARD', sequence: 1 },
    ],
  })
}

/* ================================================================== the invariant */

test('a ledger where custody equals liabilities reconciles clean', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))

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
  await post(depositEntry({ amount: 5_000n }))
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
  await post(depositEntry({ amount: 5_000n }))
  await mintUnbackedLiability(10n)

  const result = await run('SHARD', { SHARD: 100n })

  assert.equal(result.status, 'drift_within_tolerance')
  assert.equal(result.drift, '-10')
  assert.equal(result.froze, false)
  assert.deepEqual(await listFreezes(db()), [])
})

test('an asset with NO configured tolerance gets zero, not unlimited', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))
  await mintUnbackedLiability(1n)

  // One unit of drift, no tolerance configured for SHARD. Failing closed is the whole point:
  // an asset silently exempt from the only check that guards it is the worst outcome.
  const result = await run('SHARD', { EMBER: 1_000_000n })
  assert.equal(result.status, 'drift_exceeded')
  assert.equal(result.froze, true)
})

/* ================================================================== the freeze */

test('THE FREEZE: a withdrawal is refused while the asset is frozen', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))
  await mintUnbackedLiability(1_000n)
  assert.equal((await run('SHARD')).froze, true)

  // The whole mechanical consequence of reconciliation. Without this the drift alert is a log line.
  await assert.rejects(
    () => post(withdrawalEntry({ amount: 100n, kind: 'withdrawal_requested' })),
    (err: unknown) => err instanceof AssetFrozenError && err.assetCode === 'SHARD',
  )
  await assert.rejects(
    () => post(withdrawalEntry({ amount: 100n, kind: 'withdrawal_settled' })),
    AssetFrozenError,
  )
})

test('THE FREEZE: deposits and refunds are NOT blocked', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))
  await mintUnbackedLiability(1_000n)
  await run('SHARD')

  // The freeze stops value LEAVING the platform. Blocking a deposit would strand incoming money;
  // blocking a refund would harm the party the freeze exists to protect.
  await assert.doesNotReject(() => post(depositEntry({ amount: 100n })))
  await assert.doesNotReject(() =>
    post(withdrawalEntry({ amount: 100n, kind: 'withdrawal_refunded' })),
  )
})

test('THE FREEZE: another asset is unaffected', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))
  await post(depositEntry({ amount: 5_000n, assetCode: 'EMBER' }))
  await mintUnbackedLiability(1_000n)
  await run('SHARD')

  // A freeze is per asset. One drifting asset must not stop the whole platform paying out.
  await assert.doesNotReject(() =>
    post(withdrawalEntry({ amount: 100n, assetCode: 'EMBER', kind: 'withdrawal_requested' })),
  )
})

test('a freeze is lifted only by an exactly-clean run, never by one merely within tolerance', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))
  await mintUnbackedLiability(1_000n)
  assert.equal((await run('SHARD')).froze, true)

  // Still drifting, but now inside a generous tolerance. The bar to LIFT is higher than the bar
  // that set it, so an asset near the boundary cannot flap in and out of frozen on every run.
  const withinTolerance = await run('SHARD', { SHARD: 5_000n })
  assert.equal(withinTolerance.status, 'drift_within_tolerance')
  assert.equal(withinTolerance.unfroze, false)
  assert.equal((await listFreezes(db())).length, 1, 'the freeze must persist')
  await assert.rejects(() => post(withdrawalEntry({ amount: 10n })), AssetFrozenError)

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
  await assert.doesNotReject(() => post(withdrawalEntry({ amount: 10n })))
})

test('a freeze records the run that caused it, and refreshes on the latest run', { skip }, async () => {
  await post(depositEntry({ amount: 5_000n }))
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

test('an asset with no accounts at all reconciles clean at zero', { skip }, async () => {
  // A run that proves an asset is at zero is still a run worth recording.
  const result = await run('EMBER')
  assert.equal(result.status, 'clean')
  assert.equal(result.ledgerCustodyTotal, '0')
  assert.equal(result.drift, '0')
})
