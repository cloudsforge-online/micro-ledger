/**
 * Everything that can be proved without a database: id generation, fingerprinting, environment
 * parsing and request parsing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUuid, uuidv7 } from './ids.ts'
import { namespacedKey, requestFingerprint } from './idempotency.ts'
import { RECONCILE_KIND, chainNameFor, recurringJobs } from './jobs.ts'
import { LedgerValidationError, WITHDRAWAL_KINDS, validateEntryRequest } from './entries.ts'
import { parsePostEntry } from './server.ts'

/* ------------------------------------------------------------------ ids */

test('uuidv7 is a well-formed v7 uuid', () => {
  const id = uuidv7()
  assert.ok(isUuid(id), id)
  assert.equal(id[14], '7', 'the version nibble must be 7')
  assert.match(id[19]!, /[89ab]/, 'the variant nibble must be 8, 9, a or b')
})

test('uuidv7 sorts chronologically, which is what makes keyset pagination a total order', () => {
  // Generated inside one millisecond on purpose: it is the sequence counter, not the clock, that
  // has to hold the order here. Without it a replay reading `order by id` would apply same-
  // millisecond entries in a different order from the one they were posted in.
  const ids = Array.from({ length: 500 }, () => uuidv7(() => 1_700_000_000_000))
  assert.deepEqual(ids, [...ids].sort(), 'ids issued in one millisecond must still sort in issue order')
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique')
})

test('uuidv7 never goes backwards when the clock does', () => {
  const forward = uuidv7(() => 1_700_000_000_000)
  // NTP steps the clock back an hour. The next id must still sort after the previous one.
  const afterStep = uuidv7(() => 1_699_999_996_400)
  assert.ok(afterStep > forward, 'a backward clock step must not produce a backward id')
})

test('isUuid refuses what Postgres would refuse', () => {
  assert.equal(isUuid('not-a-uuid'), false)
  assert.equal(isUuid(''), false)
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111' or 1=1"), false)
})

/* ------------------------------------------------------------------ idempotency */

test('the fingerprint is stable under key order, so a legitimate retry is not a 409', () => {
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
})

test('the fingerprint changes when the body changes', () => {
  assert.notEqual(requestFingerprint({ amount: '100' }), requestFingerprint({ amount: '101' }))
  // The case that matters most: same key, one posting flipped from credit to debit.
  assert.notEqual(
    requestFingerprint({ postings: [{ direction: 'debit' }] }),
    requestFingerprint({ postings: [{ direction: 'credit' }] }),
  )
})

test('arrays are order-sensitive, because posting order is meaningful', () => {
  assert.notEqual(requestFingerprint([1, 2]), requestFingerprint([2, 1]))
})

test('keys are namespaced by service, so two services cannot collide on one key', () => {
  assert.notEqual(namespacedKey('wallet', 'POST /entries', 'k1'), namespacedKey('market', 'POST /entries', 'k1'))
  assert.notEqual(
    namespacedKey('wallet', 'POST /entries', 'k1'),
    namespacedKey('wallet', 'POST /reservations', 'k1'),
  )
})

/* ------------------------------------------------------------------ freeze scope */

test('a freeze blocks withdrawals but never a refund', () => {
  assert.ok(WITHDRAWAL_KINDS.has('withdrawal_requested'))
  assert.ok(WITHDRAWAL_KINDS.has('withdrawal_settled'))
  // Blocking a refund would harm the party the freeze exists to protect, and would strand money
  // in a clearing account for as long as the drift takes to resolve.
  assert.equal(WITHDRAWAL_KINDS.has('withdrawal_refunded'), false)
  assert.equal(WITHDRAWAL_KINDS.has('deposit_credited'), false)
})

test('a chainless asset is recorded as `platform`, not given an invented chain', () => {
  assert.equal(chainNameFor('SHARD'), 'platform')
  assert.equal(chainNameFor('USD'), 'platform')
  assert.equal(chainNameFor('TOKEN:cf:mint:token:abc'), 'platform')
  assert.equal(chainNameFor('EMBER'), 'Hearth')
})

/* ------------------------------------------------------------------ validation */

const posting = (direction: 'debit' | 'credit', amount: bigint, sequence: number) => ({
  accountId: '11111111-1111-4111-8111-111111111111',
  direction,
  amount,
  assetCode: 'EMBER' as const,
  sequence,
})

const entry = (postings: ReturnType<typeof posting>[]) => ({
  kind: 'deposit_credited' as const,
  originatingService: 'wallet',
  actor: 'system' as const,
  correlationId: 'c1',
  idempotencyKey: 'k1',
  postings,
})

test('a balanced entry validates', () => {
  assert.doesNotThrow(() => validateEntryRequest(entry([posting('debit', 100n, 0), posting('credit', 100n, 1)])))
})

test('an unbalanced entry is refused with the asset and the difference named', () => {
  assert.throws(
    () => validateEntryRequest(entry([posting('debit', 100n, 0), posting('credit', 99n, 1)])),
    (err: unknown) =>
      err instanceof LedgerValidationError && err.problems.some((p) => /EMBER is out by 1/.test(p)),
  )
})

test('a single-sided entry is refused — that is all the table this replaces could express', () => {
  assert.throws(
    () => validateEntryRequest(entry([posting('debit', 100n, 0)])),
    (err: unknown) =>
      err instanceof LedgerValidationError && err.problems.some((p) => /no counter-account/.test(p)),
  )
})

test('a negative amount is refused: direction belongs in `direction`, not in the sign', () => {
  assert.throws(
    () => validateEntryRequest(entry([posting('debit', -100n, 0), posting('credit', 100n, 1)])),
    LedgerValidationError,
  )
})

test('a posting that names no account is refused before any query runs', () => {
  assert.throws(
    () =>
      validateEntryRequest({
        ...entry([]),
        postings: [{ direction: 'debit', amount: 1n, assetCode: 'EMBER', sequence: 0 }],
      }),
    /names no account/,
  )
})

/* ------------------------------------------------------------------ request parsing */

test('an amount beyond 2^53 must be a string, and is parsed exactly', () => {
  const body = {
    kind: 'deposit_credited',
    originatingService: 'wallet',
    actor: 'system',
    idempotencyKey: 'k1',
    postings: [
      { accountId: '11111111-1111-4111-8111-111111111111', direction: 'debit', amount: '1000000000000000000', assetCode: 'EMBER', sequence: 0 },
      { accountId: '22222222-2222-4222-8222-222222222222', direction: 'credit', amount: '1000000000000000000', assetCode: 'EMBER', sequence: 1 },
    ],
  }
  const parsed = parsePostEntry(body, 'req-1')
  assert.equal(parsed.postings[0]!.amount, 1_000_000_000_000_000_000n)
})

test('a JSON number that has already lost precision is refused, not silently stored', () => {
  const body = {
    kind: 'deposit_credited',
    originatingService: 'wallet',
    actor: 'system',
    idempotencyKey: 'k1',
    postings: [{ accountId: '11111111-1111-4111-8111-111111111111', direction: 'debit', amount: 1e18, assetCode: 'EMBER', sequence: 0 }],
  }
  assert.throws(() => parsePostEntry(body, 'req-1'), /send it as a decimal string/)
})

test('the correlation id falls back to the request id rather than being absent', () => {
  const parsed = parsePostEntry(
    {
      kind: 'adjustment',
      originatingService: 'wallet',
      actor: 'system',
      idempotencyKey: 'k1',
      postings: [{ accountId: '11111111-1111-4111-8111-111111111111', direction: 'debit', amount: '1', assetCode: 'EMBER', sequence: 0 }],
    },
    'req-abc',
  )
  assert.equal(parsed.correlationId, 'req-abc')
})

test('a body with no postings is refused', () => {
  assert.throws(
    () => parsePostEntry({ kind: 'adjustment', originatingService: 'w', actor: 'system', idempotencyKey: 'k', postings: [] }, 'r'),
    /postings must be a non-empty array/,
  )
})

/*
 * micro-org#533 — one process, both networks, one sweep.
 *
 * `LEDGER_RECONCILE_NETWORK` was a scalar. After the consolidation merged the two per-network
 * ledger deployments into one, it still named `mainnet`, so the testnet sweep stopped on the day of
 * the merge and stayed stopped for a week. Nothing failed: the jobs were simply never created, and
 * the only reconciliation alert fires on a drift VALUE that a sweep which never runs cannot publish.
 */
test('recurring reconciliation fans out over every configured network', () => {
  const jobs = recurringJobs({
    reconcileAssets: ['SHARD', 'EMBER'] as const,
    reconcileNetworks: ['mainnet', 'testnet'] as const,
  })
  const reconciles = jobs.filter((job) => job.kind === RECONCILE_KIND)

  // Two assets on two networks is four jobs, not two.
  assert.equal(reconciles.length, 4)
  assert.deepEqual(
    reconciles.map((job) => job.key).sort(),
    ['asset:EMBER:mainnet', 'asset:EMBER:testnet', 'asset:SHARD:mainnet', 'asset:SHARD:testnet'],
  )

  // THE KEY MUST CARRY THE NETWORK. `seedRecurring` enqueues with `onConflict: 'keep'`, which is
  // keyed by (kind, key) — so a key of `asset:EMBER` for both networks would collapse to one row
  // and one of the two networks would never be swept. That is this defect, one layer down.
  assert.equal(new Set(reconciles.map((job) => job.key)).size, reconciles.length)

  // And the payload still states it, because the handler resolves its database from the payload.
  for (const job of reconciles) {
    const network = (job.payload as { network?: string }).network
    assert.ok(network === 'mainnet' || network === 'testnet')
    assert.ok(job.key.endsWith(`:${network}`), `${job.key} must agree with its payload network`)
  }
})

test('a single configured network produces exactly the jobs it names', () => {
  const jobs = recurringJobs({ reconcileAssets: ['EMBER'] as const, reconcileNetworks: ['testnet'] as const })
  const reconciles = jobs.filter((job) => job.kind === RECONCILE_KIND)
  assert.deepEqual(reconciles.map((job) => job.key), ['asset:EMBER:testnet'])
})
