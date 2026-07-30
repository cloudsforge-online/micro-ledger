/**
 * The posting API against a real database.
 *
 * The tests that matter most here are the ones that **bypass the application entirely** and drive
 * the tables directly. 04-domain-model.md §2.2 requires the invariants to be enforced "in the
 * database, not in application code", and a suite that only ever posts through `postEntry` would
 * prove that `validateEntryRequest` works — not that the ledger is safe. Every such test is marked.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  AccountNotPostableError,
  AlreadyReleasedError,
  InsufficientFundsError,
  LedgerValidationError,
  NotFoundError,
  listEntries,
  postEntry,
  readEntry,
  release,
  reserve,
  reverseEntryById,
  trialBalance,
  type PostEntryDeps,
} from './entries.ts'
import { IdempotencyKeyReuseError, requestFingerprint } from './idempotency.ts'
import { balancesForSubject } from './accounts.ts'
import { uuidv7 } from './ids.ts'
import {
  ALICE,
  BOB,
  custodyAccount,
  depositEntry,
  enabled,
  freshKey,
  migrateTestDb,
  openDb,
  platformFeeAccount,
  resetLedger,
  skip,
  userAccount,
  withdrawalEntry,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
const db = () => sql as unknown as Db
const deps = (): PostEntryDeps => ({ sql: db(), producer: 'ledger' })

/** Post without going through the request-shape validation, for the raw-SQL comparisons. */
const post = (request: Parameters<typeof postEntry>[1]) =>
  postEntry(deps(), request, requestFingerprint(request as unknown))

before(async () => {
  if (!enabled) return
  sql = openDb(25)
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

/** The balance of one account, as the projection holds it. */
async function balanceOf(subject: string, purpose = 'available', assetCode = 'SHARD'): Promise<bigint> {
  const balances = await balancesForSubject(db(), subject)
  const found = balances.find((b) => b.purpose === purpose && b.assetCode === assetCode)
  return BigInt(found?.amount ?? '0')
}

/* ================================================================== the happy path */

test('a balanced entry commits, and moves both sides', { skip }, async () => {
  const outcome = await post(depositEntry({ amount: 1_000n }))

  assert.equal(outcome.replayed, false)
  assert.equal(outcome.result.postings.length, 2)
  // A deposit debits custody (an asset goes up) and credits the user (our liability goes up).
  assert.equal(await balanceOf(ALICE), 1_000n)
  assert.equal(await balanceOf('custody', 'treasury'), 1_000n)

  const balance = await trialBalance(db())
  assert.equal(balance.balanced, true)
  assert.equal(balance.totalAbsoluteDelta, '0')
})

test('an entry may touch two assets at once, and each balances separately', { skip }, async () => {
  // A conversion: the user's EMBER falls and their Shards rise. The two totals have no arithmetic
  // relationship, which is exactly why the invariant is per asset rather than per entry.
  await post(depositEntry({ amount: 5_000_000_000_000_000_000n, assetCode: 'EMBER' }))

  await post({
    kind: 'conversion',
    originatingService: 'wallet',
    actor: 'system',
    correlationId: 'c-convert',
    idempotencyKey: freshKey(),
    postings: [
      { account: userAccount(ALICE, 'EMBER'), direction: 'debit', amount: 1_000_000_000_000_000_000n, assetCode: 'EMBER', sequence: 0 },
      { account: custodyAccount('EMBER'), direction: 'credit', amount: 1_000_000_000_000_000_000n, assetCode: 'EMBER', sequence: 1 },
      { account: custodyAccount('SHARD'), direction: 'debit', amount: 250n, assetCode: 'SHARD', sequence: 2 },
      { account: userAccount(ALICE, 'SHARD'), direction: 'credit', amount: 250n, assetCode: 'SHARD', sequence: 3 },
    ],
  })

  assert.equal(await balanceOf(ALICE, 'available', 'EMBER'), 4_000_000_000_000_000_000n)
  assert.equal(await balanceOf(ALICE, 'available', 'SHARD'), 250n)
  assert.equal((await trialBalance(db())).balanced, true)
})

test('amounts beyond 2^53 survive the round trip exactly', { skip }, async () => {
  // The whole reason `amount` is numeric(78,0) and every boundary is a string. A double would
  // round this, and the rounding would be silent and permanent.
  const huge = 123_456_789_012_345_678_901_234_567_890n
  await post(depositEntry({ amount: huge, assetCode: 'EMBER' }))
  assert.equal(await balanceOf(ALICE, 'available', 'EMBER'), huge)
})

/* ================================================================== INVARIANT 1 */

test(
  'THE INVARIANT: the DEFERRED trigger fires at COMMIT, with the application nowhere in the path',
  { skip },
  async () => {
    // Raw SQL, deliberately. This is what proves the database enforces the balancing rule rather
    // than `validateEntryRequest` doing it on the way in. An entry is unbalanced between its first
    // posting and its last, so the check MUST be deferred — an immediate one would reject every
    // legal entry.
    const accounts = await sql<{ id: string }[]>`
      insert into accounts (subject, type, asset_code, purpose) values
        ('custody', 'asset', 'SHARD', 'treasury'),
        (${ALICE}, 'liability', 'SHARD', 'available')
      returning id
    `
    const entryId = uuidv7()
    let insertsSucceeded = false

    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          await tx`
            insert into journal_entries (id, kind, originating_service, actor, correlation_id, idempotency_key, occurred_at)
            values (${entryId}, 'deposit_credited', 'test', 'system', 'c', ${freshKey()}, now())
          `
          await tx`
            insert into postings (entry_id, account_id, direction, amount, asset_code, sequence)
            values (${entryId}, ${accounts[0]!.id}, 'debit', 100, 'SHARD', 0)
          `
          await tx`
            insert into postings (entry_id, account_id, direction, amount, asset_code, sequence)
            values (${entryId}, ${accounts[1]!.id}, 'credit', 99, 'SHARD', 1)
          `
          // Every statement above succeeded. Nothing has complained yet, and that is the point.
          insertsSucceeded = true
          return { value: null }
        }),
      /does not balance for SHARD: debits 100, credits 99, out by 1/,
    )

    assert.equal(insertsSucceeded, true, 'the inserts must succeed; the check belongs at COMMIT')
    // And the failed COMMIT took the entry with it.
    const left = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries`
    assert.equal(left[0]!.n, 0, 'a failed commit must leave nothing behind')
  },
)

test('an entry with no postings at all is refused at COMMIT', { skip }, async () => {
  // The shape today's ledger writes as a breadcrumb: withdrawal request, refund and
  // convert-to-ember all write `delta: 0` rows. An entry that moves nothing is not an entry.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`
          insert into journal_entries (id, kind, originating_service, actor, correlation_id, idempotency_key, occurred_at)
          values (${uuidv7()}, 'adjustment', 'test', 'system', 'c', ${freshKey()}, now())
        `
        return { value: null }
      }),
    /has no postings/,
  )
})

test('postings appended to a committed entry in a later transaction also fail', { skip }, async () => {
  // Why the constraint trigger is on `postings` as well as on `journal_entries`: the entry-level
  // trigger only ever guards the transaction that created the entry.
  const outcome = await post(depositEntry({ amount: 100n }))
  const account = await sql<{ id: string }[]>`select id from accounts where subject = ${ALICE}`

  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`
          insert into postings (entry_id, account_id, direction, amount, asset_code, sequence)
          values (${outcome.result.id}, ${account[0]!.id}, 'credit', 5, 'SHARD', 99)
        `
        return { value: null }
      }),
    /does not balance/,
  )
})

test('the application refuses an unbalanced entry with a diagnosis, before the database does', { skip }, async () => {
  await assert.rejects(
    () =>
      post({
        kind: 'deposit_credited',
        originatingService: 'wallet',
        actor: 'system',
        correlationId: 'c',
        idempotencyKey: freshKey(),
        postings: [
          { account: custodyAccount(), direction: 'debit', amount: 100n, assetCode: 'SHARD', sequence: 0 },
          { account: userAccount(ALICE), direction: 'credit', amount: 99n, assetCode: 'SHARD', sequence: 1 },
        ],
      }),
    (err: unknown) =>
      err instanceof LedgerValidationError && err.problems.some((p) => /SHARD is out by 1/.test(p)),
  )
  assert.equal((await sql`select id from journal_entries`).length, 0)
})

/* ================================================================== INVARIANT 2 */

test('THE INVARIANT: postings are immutable — UPDATE is rejected', { skip }, async () => {
  const outcome = await post(depositEntry({ amount: 100n }))

  await assert.rejects(
    () => sql`update postings set amount = 999 where entry_id = ${outcome.result.id}`,
    /postings are append-only: UPDATE is refused/,
  )
  await assert.rejects(
    () => sql`delete from postings where entry_id = ${outcome.result.id}`,
    /postings are append-only: DELETE is refused/,
  )

  // Nothing moved.
  assert.equal(await balanceOf(ALICE), 100n)
})

test('journal entries are immutable too', { skip }, async () => {
  const outcome = await post(depositEntry({ amount: 100n }))
  await assert.rejects(
    () => sql`update journal_entries set kind = 'adjustment' where id = ${outcome.result.id}`,
    /append-only/,
  )
})

/* ================================================================== INVARIANT 4 */

test('THE INVARIANT: the same key twice produces ONE entry, and replays the response', { skip }, async () => {
  const key = freshKey()
  const request = depositEntry({ amount: 500n, idempotencyKey: key })

  const first = await post(request)
  const second = await post(request)

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true, 'the second call must be a replay, not a second posting')
  assert.equal(second.result.id, first.result.id, 'the replay must return the ORIGINAL entry')

  const entries = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries`
  assert.equal(entries[0]!.n, 1, 'exactly one entry')
  // The balance moved once. This is the double-credit a retry must never cause.
  assert.equal(await balanceOf(ALICE), 500n)
})

test('THE INVARIANT: the same key with a DIFFERENT body is a 409, not a replay', { skip }, async () => {
  const key = freshKey()
  await post(depositEntry({ amount: 500n, idempotencyKey: key }))

  // Returning the first request's answer to a second, different request is worse than an error:
  // the caller would believe the thing it asked for had happened.
  await assert.rejects(
    () => post(depositEntry({ amount: 900n, idempotencyKey: key })),
    IdempotencyKeyReuseError,
  )
  assert.equal(await balanceOf(ALICE), 500n)
})

test('a failed entry does not poison its own retry', { skip }, async () => {
  const key = freshKey()
  // Insufficient funds: the transaction rolls back, taking the idempotency claim with it.
  await assert.rejects(
    () => post(withdrawalEntry({ amount: 100n, idempotencyKey: key })),
    InsufficientFundsError,
  )

  await post(depositEntry({ amount: 100n }))
  // The same key now succeeds, because the claim never committed.
  const retry = await post(withdrawalEntry({ amount: 100n, idempotencyKey: key }))
  assert.equal(retry.replayed, false)
  assert.equal(await balanceOf(ALICE), 0n)
})

/* ================================================================== INVARIANT 5 */

test('THE INVARIANT: a liability may not go negative', { skip }, async () => {
  await post(depositEntry({ amount: 100n }))

  await assert.rejects(
    () => post(withdrawalEntry({ amount: 101n })),
    (err: unknown) => err instanceof InsufficientFundsError && /may not go negative/.test(err.message),
  )

  assert.equal(await balanceOf(ALICE), 100n, 'the refused entry moved nothing')
  assert.equal((await trialBalance(db())).balanced, true)
})

test('REGRESSION: a debit that spends the balance exactly down to zero is allowed', { skip }, async () => {
  // The bug this guards: the overdraft trigger was BEFORE INSERT OR UPDATE, and Postgres fires
  // BEFORE INSERT triggers before it detects an ON CONFLICT conflict — so the trigger saw the raw
  // DELTA (-100) instead of the resulting balance (0) and refused every debit. It looked correct
  // in a test that only ever tried to overspend, because overspending fails either way.
  await post(depositEntry({ amount: 100n }))
  await assert.doesNotReject(() => post(withdrawalEntry({ amount: 100n })))
  assert.equal(await balanceOf(ALICE), 0n)

  // And a partial spend, which is the same bug with a different arithmetic.
  await post(depositEntry({ amount: 100n }))
  await assert.doesNotReject(() => post(withdrawalEntry({ amount: 40n })))
  assert.equal(await balanceOf(ALICE), 60n)
})

test('an overdraft-allowed account may go negative', { skip }, async () => {
  // Only `clearing` and `suspense` get this. It is what lets value in transit be held somewhere.
  await post({
    kind: 'adjustment',
    originatingService: 'ops',
    actor: 'operator:1',
    correlationId: 'c',
    idempotencyKey: freshKey(),
    postings: [
      {
        account: { subject: 'clearing', assetCode: 'SHARD', purpose: 'suspense', type: 'clearing', overdraftAllowed: true },
        direction: 'debit',
        amount: 50n,
        assetCode: 'SHARD',
        sequence: 0,
      },
      { account: userAccount(ALICE), direction: 'credit', amount: 50n, assetCode: 'SHARD', sequence: 1 },
    ],
  })
  assert.equal(await balanceOf('clearing', 'suspense'), -50n)
  assert.equal((await trialBalance(db())).balanced, true)
})

/* ================================================================== reversal */

test('a reversal is a NEW entry that mirrors every posting, never an edit', { skip }, async () => {
  const original = await post(depositEntry({ amount: 700n }))

  const reversal = await reverseEntryById(
    deps(),
    original.result.id,
    {
      originatingService: 'ops',
      actor: 'operator:42',
      correlationId: 'c-rev',
      idempotencyKey: freshKey(),
    },
    requestFingerprint({ reason: 'wrong amount' }),
  )

  assert.equal(reversal.result.kind, 'reversal')
  assert.equal(reversal.result.reversesEntryId, original.result.id)
  assert.notEqual(reversal.result.id, original.result.id)

  // Every direction flipped, every amount identical.
  for (const posting of reversal.result.postings) {
    const mirrored = original.result.postings.find((p) => p.sequence === posting.sequence)!
    assert.equal(posting.amount, mirrored.amount)
    assert.notEqual(posting.direction, mirrored.direction)
  }

  assert.equal(await balanceOf(ALICE), 0n, 'the reversal returns the balance to where it started')
  // The audit trail shows the mistake AND the fix, which is the point of never editing.
  assert.equal((await sql`select id from journal_entries`).length, 2)
  assert.equal((await trialBalance(db())).balanced, true)
})

test('reversing a reversal lands back on the original postings', { skip }, async () => {
  const original = await post(depositEntry({ amount: 300n }))
  const first = await reverseEntryById(
    deps(),
    original.result.id,
    { originatingService: 'ops', actor: 'operator:1', correlationId: 'c', idempotencyKey: freshKey() },
    requestFingerprint({ n: 1 }),
  )
  // An operator's mis-click must be recoverable.
  await reverseEntryById(
    deps(),
    first.result.id,
    { originatingService: 'ops', actor: 'operator:1', correlationId: 'c', idempotencyKey: freshKey() },
    requestFingerprint({ n: 2 }),
  )
  assert.equal(await balanceOf(ALICE), 300n)
})

test('reversing an entry that does not exist is a 404, not a 500', { skip }, async () => {
  await assert.rejects(
    () =>
      reverseEntryById(
        deps(),
        uuidv7(),
        { originatingService: 'ops', actor: 'system', correlationId: 'c', idempotencyKey: freshKey() },
        requestFingerprint({}),
      ),
    NotFoundError,
  )
})

/* ================================================================== reservations */

test('a reservation is a posting pair from available to reserved', { skip }, async () => {
  await post(depositEntry({ amount: 1_000n }))

  const reservation = await reserve(
    deps(),
    {
      subject: ALICE,
      assetCode: 'SHARD',
      amount: 400n,
      originatingService: 'market',
      actor: 'service:market',
      correlationId: 'c-listing',
      idempotencyKey: freshKey(),
    },
    requestFingerprint({ listing: 'l-1' }),
  )

  // Two accounts, not two columns: the reservation is auditable and reversible.
  assert.equal(await balanceOf(ALICE, 'available'), 600n)
  assert.equal(await balanceOf(ALICE, 'reserved'), 400n)
  assert.equal(reservation.result.postings.length, 2)
  assert.equal((await trialBalance(db())).balanced, true)
})

test('a reservation cannot exceed what is available — "sold twice" is unrepresentable', { skip }, async () => {
  await post(depositEntry({ amount: 100n }))
  await reserve(
    deps(),
    { subject: ALICE, assetCode: 'SHARD', amount: 100n, originatingService: 'market', actor: 'service:market', correlationId: 'c', idempotencyKey: freshKey() },
    requestFingerprint({ n: 1 }),
  )
  // The second listing cannot reserve, so it cannot be listed.
  await assert.rejects(
    () =>
      reserve(
        deps(),
        { subject: ALICE, assetCode: 'SHARD', amount: 100n, originatingService: 'market', actor: 'service:market', correlationId: 'c', idempotencyKey: freshKey() },
        requestFingerprint({ n: 2 }),
      ),
    InsufficientFundsError,
  )
  assert.equal(await balanceOf(ALICE, 'reserved'), 100n)
})

test('releasing returns the value, and a second release is refused', { skip }, async () => {
  await post(depositEntry({ amount: 1_000n }))
  const reservation = await reserve(
    deps(),
    { subject: ALICE, assetCode: 'SHARD', amount: 400n, originatingService: 'market', actor: 'service:market', correlationId: 'c', idempotencyKey: freshKey() },
    requestFingerprint({ listing: 'l-1' }),
  )

  await release(
    deps(),
    reservation.result.id,
    { originatingService: 'market', actor: 'service:market', correlationId: 'c', idempotencyKey: freshKey() },
    requestFingerprint({ n: 1 }),
  )
  assert.equal(await balanceOf(ALICE, 'available'), 1_000n)
  assert.equal(await balanceOf(ALICE, 'reserved'), 0n)

  // A DIFFERENT request releasing the same reservation. No idempotency key would catch this; the
  // FOR UPDATE lock and the existence check are what do.
  await assert.rejects(
    () =>
      release(
        deps(),
        reservation.result.id,
        { originatingService: 'market', actor: 'service:market', correlationId: 'c', idempotencyKey: freshKey() },
        requestFingerprint({ n: 2 }),
      ),
    AlreadyReleasedError,
  )
  assert.equal(await balanceOf(ALICE, 'available'), 1_000n)
})

test('an entry that is not a reservation cannot be released', { skip }, async () => {
  const deposit = await post(depositEntry({ amount: 100n }))
  await assert.rejects(
    () =>
      release(
        deps(),
        deposit.result.id,
        { originatingService: 'market', actor: 'service:market', correlationId: 'c', idempotencyKey: freshKey() },
        requestFingerprint({}),
      ),
    (err: unknown) => err instanceof LedgerValidationError && /not a reservation/.test(err.message),
  )
})

/* ================================================================== accounts */

test('the account key is unique: one subject+asset+purpose is one account', { skip }, async () => {
  await post(depositEntry({ amount: 100n }))
  await post(depositEntry({ amount: 200n }))
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from accounts where subject = ${ALICE} and asset_code = 'SHARD' and purpose = 'available'
  `
  assert.equal(rows[0]!.n, 1, 'a second account for one key would split the balance in half')
  assert.equal(await balanceOf(ALICE), 300n)
})

test('posting to a closed account is refused', { skip }, async () => {
  await post(depositEntry({ amount: 100n }))
  await sql`update accounts set status = 'closed' where subject = ${ALICE}`
  await assert.rejects(() => post(depositEntry({ amount: 50n })), AccountNotPostableError)
})

test('a frozen account still accepts corrections, so a wrong balance stays fixable', { skip }, async () => {
  await post(depositEntry({ amount: 100n }))
  await sql`update accounts set status = 'frozen' where subject = ${ALICE}`

  await assert.rejects(() => post(depositEntry({ amount: 50n })), AccountNotPostableError)
  // If a freeze blocked corrections too, the only way to fix a frozen account would be to unfreeze
  // it — which is the moment the wrong balance becomes spendable.
  await assert.doesNotReject(() => post(depositEntry({ amount: 50n, kind: 'adjustment' })))
})

test('a posting whose asset disagrees with its account is refused', { skip }, async () => {
  await assert.rejects(
    () =>
      post({
        kind: 'adjustment',
        originatingService: 'ops',
        actor: 'system',
        correlationId: 'c',
        idempotencyKey: freshKey(),
        postings: [
          // The account is a SHARD account; the posting claims EMBER.
          { account: userAccount(ALICE, 'SHARD'), direction: 'debit', amount: 5n, assetCode: 'EMBER', sequence: 0 },
          { account: custodyAccount('EMBER'), direction: 'credit', amount: 5n, assetCode: 'EMBER', sequence: 1 },
        ],
      }),
    (err: unknown) => err instanceof LedgerValidationError && /but account/.test(err.message),
  )
})

/* ================================================================== reading */

test('entries are paginated by keyset, and the pages tile the journal exactly', { skip }, async () => {
  for (let i = 0; i < 25; i++) await post(depositEntry({ amount: BigInt(i + 1) }))

  const seen: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await listEntries(db(), { limit: 10, ...(cursor ? { cursor } : {}) })
    seen.push(...page.entries.map((e) => e.id))
    cursor = page.nextCursor
    pages += 1
    assert.ok(pages < 10, 'pagination must terminate')
  } while (cursor)

  assert.equal(seen.length, 25, 'every entry appears exactly once across the pages')
  assert.equal(new Set(seen).size, 25, 'no entry appears twice')
  // UUIDv7 sorts chronologically, so descending id is reverse chronological with no ambiguity.
  assert.deepEqual(seen, [...seen].sort().reverse())
})

test('entries can be filtered by originating service, which is what makes revenue attributable', { skip }, async () => {
  await post(depositEntry({ amount: 10n, originatingService: 'wallet' }))
  await post(depositEntry({ amount: 20n, originatingService: 'market' }))
  await post(depositEntry({ amount: 30n, originatingService: 'market' }))

  const page = await listEntries(db(), { limit: 50, originatingService: 'market' })
  assert.equal(page.entries.length, 2)
  assert.ok(page.entries.every((e) => e.originatingService === 'market'))
})

test('every entry records the calling service and the actor', { skip }, async () => {
  const outcome = await post(depositEntry({ amount: 10n, originatingService: 'forgemint' }))
  const stored = await readEntry(db(), outcome.result.id)
  assert.equal(stored!.originatingService, 'forgemint')
  assert.equal(stored!.actor, 'system')
  assert.ok(stored!.correlationId.length > 0)
})

test('the trial balance reports per asset, and a fee entry still nets to zero', { skip }, async () => {
  await post(depositEntry({ amount: 1_000n }))
  // A purchase with a platform fee: three accounts, one entry, still balanced.
  await post({
    kind: 'purchase',
    originatingService: 'market',
    actor: 'service:market',
    correlationId: 'c-purchase',
    idempotencyKey: freshKey(),
    postings: [
      { account: userAccount(ALICE), direction: 'debit', amount: 100n, assetCode: 'SHARD', sequence: 0 },
      { account: userAccount(BOB), direction: 'credit', amount: 90n, assetCode: 'SHARD', sequence: 1 },
      { account: platformFeeAccount(), direction: 'credit', amount: 10n, assetCode: 'SHARD', sequence: 2 },
    ],
  })

  assert.equal(await balanceOf(ALICE), 900n)
  assert.equal(await balanceOf(BOB), 90n)
  assert.equal(await balanceOf('platform', 'fees'), 10n)

  const balance = await trialBalance(db())
  assert.equal(balance.balanced, true)
  assert.equal(balance.totalAbsoluteDelta, '0')
  assert.equal(balance.assets.find((a) => a.assetCode === 'SHARD')!.delta, '0')
})
