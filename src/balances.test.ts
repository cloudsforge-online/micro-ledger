/**
 * The projection, and the replay that proves it.
 *
 * 04-domain-model.md §2.3: the balance table is a projection, not a source of truth, and must be
 * **rebuildable from the journal by replay**. That is the property this file tests, and it is the
 * one thing `forge-pay` cannot do at all: `wallets.shards` is a running column that *is* the truth,
 * so a wrong balance is wrong for ever and nothing can detect it.
 *
 * The rebuild is only worth having if it would actually notice. So the tests below do not just
 * confirm that a clean ledger replays clean — they corrupt the projection deliberately and assert
 * that the replay catches it, names the account, and states both numbers.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { applyPosting } from '@cloudsforge/contracts-money'
import { postEntry, reverseEntryById, type PostEntryDeps } from './entries.ts'
import { requestFingerprint } from './idempotency.ts'
import { rebuildBalances, replayBalances } from './balances.ts'
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
const post = (request: Parameters<typeof postEntry>[1]) =>
  postEntry(deps(), request, requestFingerprint(request as unknown))

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

/** A journal with every shape in it: multi-asset, fees, reversals, reservations. */
async function buildJournal(): Promise<void> {
  await post(depositEntry({ amount: 10_000n }))
  await post(depositEntry({ amount: 7_500n, subject: BOB }))
  await post(depositEntry({ amount: 4_000_000_000_000_000_000n, assetCode: 'EMBER' }))

  await post({
    kind: 'purchase',
    originatingService: 'market',
    actor: 'service:market',
    correlationId: 'c-purchase',
    idempotencyKey: freshKey(),
    postings: [
      { account: userAccount(ALICE), direction: 'debit', amount: 1_000n, assetCode: 'EMBER', sequence: 0 },
      { account: userAccount(BOB), direction: 'credit', amount: 950n, assetCode: 'EMBER', sequence: 1 },
      { account: platformFeeAccount(), direction: 'credit', amount: 50n, assetCode: 'EMBER', sequence: 2 },
    ],
  })

  await post({
    kind: 'transfer',
    originatingService: 'market',
    actor: 'service:market',
    correlationId: 'c-reserve',
    idempotencyKey: freshKey(),
    postings: [
      { account: userAccount(ALICE), direction: 'debit', amount: 2_000n, assetCode: 'EMBER', sequence: 0 },
      { account: userAccount(ALICE, 'EMBER', 'reserved'), direction: 'credit', amount: 2_000n, assetCode: 'EMBER', sequence: 1 },
    ],
  })

  const doomed = await post(depositEntry({ amount: 333n, subject: BOB }))
  await reverseEntryById(
    deps(),
    doomed.result.id,
    { originatingService: 'ops', actor: 'operator:1', correlationId: 'c-rev', idempotencyKey: freshKey() },
    requestFingerprint({ reason: 'mistake' }),
  )

  await post(withdrawalEntry({ amount: 500n }))
  await post({
    kind: 'conversion',
    originatingService: 'wallet',
    actor: 'system',
    correlationId: 'c-conv',
    idempotencyKey: freshKey(),
    postings: [
      { account: userAccount(ALICE, 'EMBER'), direction: 'debit', amount: 1_000_000_000_000_000_000n, assetCode: 'EMBER', sequence: 0 },
      { account: custodyAccount('EMBER'), direction: 'credit', amount: 1_000_000_000_000_000_000n, assetCode: 'EMBER', sequence: 1 },
      { account: custodyAccount('EMBER'), direction: 'debit', amount: 250n, assetCode: 'EMBER', sequence: 2 },
      { account: userAccount(ALICE), direction: 'credit', amount: 250n, assetCode: 'EMBER', sequence: 3 },
    ],
  })
}

/* ================================================================== the replay */

test('THE REPLAY: rebuilding from the journal reproduces the projection exactly', { skip }, async () => {
  await buildJournal()

  const report = await rebuildBalances(db())

  assert.equal(report.clean, true, `mismatches: ${JSON.stringify(report.mismatches)}`)
  assert.equal(report.mismatches.length, 0)
  assert.ok(report.checked > 0, 'the replay must actually have checked something')
  assert.ok(report.postingsRead > 0)

  // Every row in the projection has a counterpart in the shadow, and vice versa. A rebuild that
  // silently compared an empty shadow with an empty projection would report clean too.
  const rows = await sql<{ projected: number; shadow: number }[]>`
    select (select count(*)::int from balances) as projected,
           (select count(*)::int from balances_shadow) as shadow
  `
  assert.equal(rows[0]!.projected, rows[0]!.shadow)
  assert.ok(rows[0]!.projected > 4, 'the fixture should touch several accounts')
})

test('THE REPLAY: a corrupted projection is caught, and both numbers are reported', { skip }, async () => {
  await buildJournal()
  assert.equal((await rebuildBalances(db())).clean, true)

  // Simulate the failure the nightly job exists to find: the projection says one thing and the
  // journal says another. There is no legitimate way for this to happen, which is exactly why a
  // mismatch is a P0 rather than something to repair automatically.
  const account = await sql<{ id: string }[]>`
    select id from accounts where subject = ${ALICE} and purpose = 'available' and asset_code = 'EMBER'
  `
  await sql`
    update balances set amount = amount + 1
     where account_id = ${account[0]!.id} and asset_code = 'EMBER'
  `

  const report = await rebuildBalances(db())
  assert.equal(report.clean, false, 'a drifted projection MUST be caught')
  assert.equal(report.mismatches.length, 1)

  const mismatch = report.mismatches[0]!
  assert.equal(mismatch.accountId, account[0]!.id)
  assert.equal(mismatch.assetCode, 'EMBER')
  assert.equal(mismatch.difference, '1', 'the projection claims one more than the journal')
  // Both sides are reported, because an operator needs to know which is which before deciding.
  assert.equal(BigInt(mismatch.projected) - BigInt(mismatch.replayed), 1n)
})

test('THE REPLAY: a projection row with no postings behind it is caught', { skip }, async () => {
  await buildJournal()

  // A balance for an account the journal has never touched. A loop over the postings alone would
  // never look at this row; the FULL OUTER JOIN is what finds it.
  const orphan = await sql<{ id: string }[]>`
    insert into accounts (subject, type, asset_code, purpose)
    values ('user:99999999-9999-4999-8999-999999999999', 'liability', 'EMBER', 'available')
    returning id
  `
  await sql`
    insert into balances (account_id, asset_code, amount) values (${orphan[0]!.id}, 'EMBER', 42)
  `

  const report = await rebuildBalances(db())
  assert.equal(report.clean, false)
  const mismatch = report.mismatches.find((m) => m.accountId === orphan[0]!.id)
  assert.ok(mismatch, 'a balance with no journal behind it must be reported')
  assert.equal(mismatch.projected, '42')
  assert.equal(mismatch.replayed, '0')
})

test('THE REPLAY: the rebuild is idempotent and the shadow is rewritten, not appended', { skip }, async () => {
  await buildJournal()
  const first = await rebuildBalances(db())
  const second = await rebuildBalances(db())

  assert.equal(first.clean, true)
  assert.equal(second.clean, true)
  assert.equal(first.checked, second.checked)

  const rows = await sql<{ n: number }[]>`select count(*)::int as n from balances_shadow`
  assert.equal(rows[0]!.n, first.checked, 'a second run must not double the shadow')
})

test('the replay agrees with applyPosting computed independently in the test', { skip }, async () => {
  await buildJournal()
  const { balances } = await replayBalances(db())

  // Recompute one account's balance here, from the raw postings, using the same contract function.
  // If the replay had quietly re-expressed the sign convention in SQL, this is where it would show.
  const account = await sql<{ id: string; type: string }[]>`
    select id, type from accounts where subject = ${ALICE} and purpose = 'available' and asset_code = 'EMBER'
  `
  const postings = await sql<{ direction: string; amount: string; sequence: number }[]>`
    select direction, amount::text as amount, sequence
      from postings
     where account_id = ${account[0]!.id} and asset_code = 'EMBER'
     order by entry_id, sequence
  `

  let expected = 0n
  for (const row of postings) {
    expected = applyPosting(
      expected,
      {
        accountId: account[0]!.id,
        direction: row.direction === 'debit' ? 'debit' : 'credit',
        amount: BigInt(row.amount),
        assetCode: 'EMBER',
        sequence: row.sequence,
      },
      'liability',
    )
  }

  assert.equal(balances.get(`${account[0]!.id}|EMBER`), expected)
  assert.ok(expected > 0n, 'the fixture should leave Alice with a positive balance')
})

test('replaying an empty journal is clean rather than an error', { skip }, async () => {
  const report = await rebuildBalances(db())
  assert.equal(report.clean, true)
  assert.equal(report.checked, 0)
  assert.equal(report.postingsRead, 0)
})
