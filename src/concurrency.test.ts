/**
 * What happens when N callers arrive at once.
 *
 * These are the tests the service exists for. Every defect they guard against is one the estate
 * has today, and none of them is reachable by a single-threaded test:
 *
 *   * Two withdrawal workers signing against one nonce, because the only guard was a module-local
 *     boolean that a second process cannot see.
 *   * Two settlement sweeps minting two idempotency keys for one fee, and billing the customer
 *     twice.
 *   * A balance spent twice, because `wallets.shards` is a running column read and written without
 *     a lock.
 *
 * The tests deliberately do not sleep, stagger or retry. They fire everything at once with
 * `Promise.allSettled` and assert on the aggregate, because a race that needs help to appear is a
 * race that will appear in production without it.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { InsufficientFundsError, postEntry, trialBalance, type PostEntryDeps } from './entries.ts'
import { IdempotencyInFlightError, requestFingerprint } from './idempotency.ts'
import { balancesForSubject } from './accounts.ts'
import {
  ALICE,
  depositEntry,
  enabled,
  freshKey,
  migrateTestDb,
  openDb,
  resetLedger,
  skip,
  withdrawalEntry,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

/** Comfortably above the widest fan-out below, so a blocked transaction never starves for one. */
const POOL = 40

let sql: postgres.Sql
const db = () => sql as unknown as Db
const deps = (): PostEntryDeps => ({ sql: db(), producer: 'ledger' })

before(async () => {
  if (!enabled) return
  sql = openDb(POOL)
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 10 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetLedger(sql)
})

async function balanceOf(subject: string, purpose = 'available'): Promise<bigint> {
  const balances = await balancesForSubject(db(), subject)
  return BigInt(balances.find((b) => b.purpose === purpose)?.amount ?? '0')
}

/* ================================================================== idempotency */

test(
  'CONCURRENCY: 16 parallel posts with ONE idempotency key produce exactly ONE entry',
  { skip },
  async () => {
    const key = freshKey()
    const request = depositEntry({ amount: 1_000n, idempotencyKey: key })
    const body = requestFingerprint(request as unknown)

    // All at once, from 16 connections. The first to insert the claim wins; the other 15 block on
    // the conflicting insert until it commits, then read the stored response and replay it.
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => postEntry(deps(), request, body)),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    // An in-flight rejection is legitimate (the claim existed but its response had not committed
    // yet) and is what a caller retries. What must never happen is a second ENTRY.
    const rejected = results.filter((r) => r.status === 'rejected')
    for (const failure of rejected) {
      assert.ok(
        (failure as PromiseRejectedResult).reason instanceof IdempotencyInFlightError,
        `unexpected rejection: ${String((failure as PromiseRejectedResult).reason)}`,
      )
    }
    assert.ok(fulfilled.length >= 1, 'at least one call must succeed')

    // THE ASSERTION: one entry, whatever happened above.
    const entries = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries`
    assert.equal(entries[0]!.n, 1, 'N parallel posts of one key must produce exactly one entry')

    const postings = await sql<{ n: number }[]>`select count(*)::int as n from postings`
    assert.equal(postings[0]!.n, 2, 'and exactly one entry"s worth of postings')

    // Credited once, not sixteen times. This is the double-credit a retry storm must never cause.
    assert.equal(await balanceOf(ALICE), 1_000n)

    // Every successful caller got the same entry id back.
    const ids = new Set(
      fulfilled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof postEntry>>>).value.result.id),
    )
    assert.equal(ids.size, 1, 'every caller must be told about the same entry')

    assert.equal((await trialBalance(db())).balanced, true)
  },
)

test('CONCURRENCY: parallel posts with DIFFERENT keys all land', { skip }, async () => {
  // The mirror of the test above: idempotency must not be so eager that it swallows genuinely
  // distinct work arriving at the same instant.
  const requests = Array.from({ length: 16 }, (_, i) => depositEntry({ amount: BigInt(i + 1) }))
  const results = await Promise.allSettled(
    requests.map((request) => postEntry(deps(), request, requestFingerprint(request as unknown))),
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 16)

  const entries = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries`
  assert.equal(entries[0]!.n, 16)
  // 1 + 2 + ... + 16
  assert.equal(await balanceOf(ALICE), 136n)
  assert.equal((await trialBalance(db())).balanced, true)
})

/* ================================================================== overdraft under load */

test(
  'CONCURRENCY: 20 parallel debits against one account never drive a liability negative',
  { skip },
  async () => {
    // Exactly ten of the twenty can be paid. Which ten is not determined — but the count is, and
    // the balance must never pass through a negative value on the way there.
    await postEntry(
      deps(),
      depositEntry({ amount: 100n }),
      requestFingerprint({ seed: 'deposit' }),
    )

    const attempts = Array.from({ length: 20 }, () => withdrawalEntry({ amount: 10n }))
    const results = await Promise.allSettled(
      attempts.map((request) => postEntry(deps(), request, requestFingerprint(request as unknown))),
    )

    const succeeded = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.filter((r) => r.status === 'rejected')

    // Every failure must be an overdraft refusal, not a deadlock, a serialisation error or a
    // driver fault. A deadlock here would mean the balance updates are not applied in a total
    // order, which is the bug `applyToBalances` sorts to prevent.
    for (const failure of failed) {
      const reason = (failure as PromiseRejectedResult).reason
      assert.ok(
        reason instanceof InsufficientFundsError,
        `expected an overdraft refusal, got: ${String(reason)}`,
      )
    }

    assert.equal(succeeded, 10, 'exactly ten debits of 10 fit inside a balance of 100')
    assert.equal(failed.length, 10)

    // THE ASSERTION: the account landed exactly on zero and never went below it.
    const finalBalance = await balanceOf(ALICE)
    assert.equal(finalBalance, 0n)
    assert.ok(finalBalance >= 0n, 'a liability must never be negative')

    // And the ledger still balances: the refused debits left nothing behind.
    const balance = await trialBalance(db())
    assert.equal(balance.balanced, true)
    assert.equal(balance.entryCount, 11, 'one deposit plus the ten debits that fit')
  },
)

test(
  'CONCURRENCY: interleaved credits and debits leave the balance exactly right',
  { skip },
  async () => {
    await postEntry(deps(), depositEntry({ amount: 500n }), requestFingerprint({ seed: 'open' }))

    // 10 credits of 20 (+200) and 10 debits of 15 (-150) fired together. Every one of them fits
    // inside the opening balance, so all 20 must commit and the arithmetic must be exact.
    const requests = [
      ...Array.from({ length: 10 }, () => depositEntry({ amount: 20n })),
      ...Array.from({ length: 10 }, () => withdrawalEntry({ amount: 15n })),
    ]
    const results = await Promise.allSettled(
      requests.map((request) => postEntry(deps(), request, requestFingerprint(request as unknown))),
    )
    for (const r of results) {
      assert.equal(r.status, 'fulfilled', `unexpected failure: ${String((r as PromiseRejectedResult).reason)}`)
    }

    assert.equal(await balanceOf(ALICE), 500n + 200n - 150n)
    assert.equal((await trialBalance(db())).balanced, true)
  },
)

test('CONCURRENCY: an unbalanced entry under load is refused without disturbing the rest', { skip }, async () => {
  await postEntry(deps(), depositEntry({ amount: 1_000n }), requestFingerprint({ seed: 'open' }))

  // Legitimate traffic with one poisoned entry in the middle, written as raw SQL so it bypasses
  // the application check and must be stopped by the deferred trigger at COMMIT.
  const good = Array.from({ length: 8 }, () => depositEntry({ amount: 5n }))
  const poison = sql.begin(async (tx) => {
    const account = await tx<{ id: string }[]>`select id from accounts where subject = ${ALICE} limit 1`
    const entryId = '019a0000-0000-7000-8000-00000000dead'
    await tx`
      insert into journal_entries (id, kind, originating_service, actor, correlation_id, idempotency_key, occurred_at)
      values (${entryId}, 'adjustment', 'test', 'system', 'c', ${freshKey()}, now())
    `
    await tx`
      insert into postings (entry_id, account_id, direction, amount, asset_code, sequence)
      values (${entryId}, ${account[0]!.id}, 'credit', 999, 'EMBER', 0)
    `
    return { value: null }
  })

  const results = await Promise.allSettled([
    ...good.map((request) => postEntry(deps(), request, requestFingerprint(request as unknown))),
    poison,
  ])

  assert.equal(results[results.length - 1]!.status, 'rejected', 'the single-sided entry must be refused')
  assert.equal(results.slice(0, 8).filter((r) => r.status === 'fulfilled').length, 8)

  assert.equal(await balanceOf(ALICE), 1_040n, 'only the legitimate entries moved anything')
  assert.equal((await trialBalance(db())).balanced, true)
})
