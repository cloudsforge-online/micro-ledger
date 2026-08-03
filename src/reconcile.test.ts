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
import { RECONCILIATION_COMPLETED, listFreezes, latestRuns, reconcileAsset } from './reconcile.ts'
import { topicSpec } from '@cloudsforge/contracts-events'
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

const run = (assetCode: 'SHARD' | 'EMBER', tolerance: Record<string, bigint> = {}) =>
  reconcileAsset(db(), { assetCode, chain: 'platform', network: 'testnet', tolerance, producer: 'ledger' })

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

test('an asset with no accounts at all reconciles clean at zero', { skip }, async () => {
  // A run that proves an asset is at zero is still a run worth recording.
  const result = await run('EMBER')
  assert.equal(result.status, 'clean')
  assert.equal(result.ledgerCustodyTotal, '0')
  assert.equal(result.drift, '0')
})

/* ================================================================== the announcement */

/**
 * **A COMPLETED RECONCILIATION TOLD NOBODY, FOR THE LIFE OF THIS SERVICE.**
 *
 * `ledger.reconciliation.completed` was registered with `producer: 'ledger'` before the service
 * existed. `activity/src/classify.ts:335` classifies it as `wallet.reconciliation_completed` and
 * reads `drift` off the payload; `analytics/src/catalogue.ts:312` records it, deliberately
 * impersonal, "kept because a reconciliation freeze explains a hole in every funnel that week";
 * `notify/src/catalogue.ts:842` files it under NON_NOTIFYING_TOPICS with a written reason — no
 * individual user is its subject — which is a decision rather than a gap. `server.ts:528` already
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
  await post(depositEntry({ amount: 5_000n }))
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
  await post(depositEntry({ amount: 5_000n }))
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

  // `activity/src/classify.ts:341` renders "Reconciliation completed with drift <drift>" and reads
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
  await post(depositEntry({ amount: 5_000n }))
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
  await post(depositEntry({ amount: 5_000n }))
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
