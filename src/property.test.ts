/**
 * The property: **after every commit, the trial balance is exactly zero.**
 *
 * Not "close to zero", not "zero within a tolerance" — exactly zero, as an integer, for every
 * asset, after every single entry. That is the one statement from which everything else the ledger
 * claims follows, and it is the number the panel in 02-target-architecture.md §6.2 monitors.
 *
 * Generated rather than enumerated, because the interesting entries are the ones nobody thought to
 * write by hand: five postings across two assets with a fee, a reversal of a reversal, a debit
 * that overdraws and must leave nothing behind. The generator emits legal and illegal entries
 * alike and the assertion is the same after both — an entry that was refused must move the trial
 * balance exactly as little as an entry that was never sent.
 *
 * The PRNG is seeded and the seed is printed on failure, so a counterexample is reproducible
 * rather than a story about something that happened once on CI.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import {
  InsufficientFundsError,
  LedgerValidationError,
  postEntry,
  reverseEntryById,
  trialBalance,
  type PostEntryRequest,
  type PostingRequest,
  type PostEntryDeps,
} from './entries.ts'
import { requestFingerprint } from './idempotency.ts'
import { rebuildBalances } from './balances.ts'
import { enabled, freshKey, migrateTestDb, openDb, resetLedger, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
const db = () => sql as unknown as Db
const deps = (): PostEntryDeps => ({ sql: db(), producer: 'ledger' })

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

/* ------------------------------------------------------------------ generation */

/** mulberry32 — small, fast, and deterministic from one 32-bit seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ASSETS: LedgerAssetCode[] = ['BTC', 'EMBER']
const USERS = [
  'user:aaaaaaaa-0000-4000-8000-000000000001',
  'user:aaaaaaaa-0000-4000-8000-000000000002',
  'user:aaaaaaaa-0000-4000-8000-000000000003',
]

/** Every account the generator may touch, with the type it must be created as. */
function accountPool(assetCode: LedgerAssetCode): NonNullable<PostingRequest['account']>[] {
  return [
    ...USERS.map(
      (subject) =>
        ({ subject, assetCode, purpose: 'available', type: 'liability' }) as NonNullable<
          PostingRequest['account']
        >,
    ),
    ...USERS.map(
      (subject) =>
        ({ subject, assetCode, purpose: 'reserved', type: 'liability' }) as NonNullable<
          PostingRequest['account']
        >,
    ),
    { subject: 'custody', assetCode, purpose: 'treasury', type: 'asset' },
    { subject: 'platform', assetCode, purpose: 'fees', type: 'revenue' },
    { subject: 'clearing', assetCode, purpose: 'suspense', type: 'clearing', overdraftAllowed: true },
  ]
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!

/** Split `total` into `parts` positive integers. Every part is at least 1, so no amount is zero. */
function split(random: () => number, total: bigint, parts: number): bigint[] {
  if (parts <= 1) return [total]
  const out: bigint[] = []
  let left = total
  for (let i = 0; i < parts - 1; i++) {
    const remaining = BigInt(parts - i - 1)
    // Leave at least 1 for every part still to come.
    const max = left - remaining
    if (max <= 1n) {
      out.push(1n)
      left -= 1n
      continue
    }
    const take = 1n + BigInt(Math.floor(random() * Number(max > 1_000n ? 1_000n : max - 1n)))
    out.push(take)
    left -= take
  }
  out.push(left)
  return out
}

/**
 * A balanced entry across one or two assets.
 *
 * Balanced BY CONSTRUCTION: for each asset an amount is chosen and then split independently across
 * the debit side and the credit side, so the two sides are equal without the generator ever
 * needing to know the balancing rule. The database is what proves it, not the generator.
 */
function generateEntry(random: () => number): PostEntryRequest {
  const assetCount = random() < 0.25 ? 2 : 1
  const assets = assetCount === 2 ? ASSETS : [pick(random, ASSETS)]

  const postings: PostingRequest[] = []
  let sequence = 0

  for (const assetCode of assets) {
    const pool = accountPool(assetCode)
    const total = BigInt(1 + Math.floor(random() * 5_000))
    const debitParts = 1 + Math.floor(random() * 2)
    const creditParts = 1 + Math.floor(random() * 2)

    for (const amount of split(random, total, debitParts)) {
      postings.push({ account: pick(random, pool), direction: 'debit', amount, assetCode, sequence: sequence++ })
    }
    for (const amount of split(random, total, creditParts)) {
      postings.push({ account: pick(random, pool), direction: 'credit', amount, assetCode, sequence: sequence++ })
    }
  }

  return {
    kind: pick(random, ['transfer', 'purchase', 'fee_charged', 'adjustment', 'reward_granted'] as const),
    originatingService: pick(random, ['wallet', 'market', 'billing', 'worlds']),
    actor: 'system',
    correlationId: `prop-${freshKey()}`,
    idempotencyKey: freshKey('prop'),
    postings,
  }
}

/** An entry that must be refused. Every shape here is one the old single-sided table could express. */
function generateIllegalEntry(random: () => number): PostEntryRequest {
  const assetCode = pick(random, ASSETS)
  const pool = accountPool(assetCode)
  const legal = generateEntry(random)
  const mode = Math.floor(random() * 3)

  if (mode === 0) {
    // Single-sided: precisely what `ledger.delta` is, and nothing else.
    return {
      ...legal,
      idempotencyKey: freshKey('bad'),
      postings: [{ account: pick(random, pool), direction: 'debit', amount: 500n, assetCode, sequence: 0 }],
    }
  }
  if (mode === 1) {
    // Out by one. The quietest possible wrong number.
    return {
      ...legal,
      idempotencyKey: freshKey('bad'),
      postings: [
        { account: pick(random, pool), direction: 'debit', amount: 500n, assetCode, sequence: 0 },
        { account: pick(random, pool), direction: 'credit', amount: 499n, assetCode, sequence: 1 },
      ],
    }
  }
  // A sign smuggled into the amount, which is how a posting set ported from the old column looks.
  return {
    ...legal,
    idempotencyKey: freshKey('bad'),
    postings: [
      { account: pick(random, pool), direction: 'debit', amount: -500n, assetCode, sequence: 0 },
      { account: pick(random, pool), direction: 'credit', amount: 500n, assetCode, sequence: 1 },
    ],
  }
}

/**
 * Give every account something to spend.
 *
 * Without this the generator's debits are almost all refused for want of funds, and the property
 * is then being proved over a ledger that mostly rejected everything — technically true and
 * practically vacuous. One opening entry per asset: custody is debited (an asset rises) and every
 * credit-normal account is credited, which balances because it is the same total.
 *
 * The clearing/suspense account is deliberately left at zero. It is the one account permitted to
 * go negative, and leaving it empty means the generator actually exercises that permission.
 */
async function seedOpeningBalances(opening: bigint): Promise<void> {
  for (const assetCode of ASSETS) {
    const creditSide = accountPool(assetCode).filter(
      (account) => account.type === 'liability' || account.type === 'revenue',
    )
    const postings: PostingRequest[] = [
      {
        account: { subject: 'custody', assetCode, purpose: 'treasury', type: 'asset' },
        direction: 'debit',
        amount: opening * BigInt(creditSide.length),
        assetCode,
        sequence: 0,
      },
      ...creditSide.map((account, index) => ({
        account,
        direction: 'credit' as const,
        amount: opening,
        assetCode,
        sequence: index + 1,
      })),
    ]

    await postEntry(
      deps(),
      {
        kind: 'adjustment',
        originatingService: 'ops',
        actor: 'system',
        correlationId: `open-${assetCode}`,
        idempotencyKey: freshKey(`open-${assetCode}`),
        description: `Opening balances for ${assetCode}`,
        postings,
      },
      requestFingerprint({ opening: assetCode }),
    )
  }
}

/* ------------------------------------------------------------------ the property */

test(
  'PROPERTY: the trial balance is exactly zero after every commit, over 150 generated entries',
  { skip },
  async () => {
    const seed = 0x5eed_1234
    const random = rng(seed)
    const context = (n: number) => `seed=${seed} iteration=${n}`

    await seedOpeningBalances(10_000_000n)

    let committed = 0
    let refused = 0

    for (let i = 0; i < 150; i++) {
      // One in five is illegal. The assertion afterwards is identical, which is the point: a
      // refused entry must move the trial balance exactly as little as one never sent.
      const illegal = random() < 0.2
      const request = illegal ? generateIllegalEntry(random) : generateEntry(random)

      try {
        await postEntry(deps(), request, requestFingerprint(request as unknown))
        committed += 1
        assert.equal(illegal, false, `an illegal entry was accepted — ${context(i)}`)
      } catch (err) {
        refused += 1
        // The only legitimate refusals. Anything else — a deadlock, a driver fault, a constraint
        // nobody expected — is a failure, not a tolerated outcome.
        assert.ok(
          err instanceof LedgerValidationError || err instanceof InsufficientFundsError,
          `unexpected failure at ${context(i)}: ${String(err)}`,
        )
      }

      // THE PROPERTY, checked after every single iteration rather than once at the end. Checking
      // only at the end would let two errors cancel out and report a clean ledger.
      const balance = await trialBalance(db())
      assert.equal(balance.totalAbsoluteDelta, '0', `trial balance is not zero at ${context(i)}`)
      assert.equal(balance.balanced, true, context(i))
      for (const asset of balance.assets) {
        assert.equal(asset.delta, '0', `${asset.assetCode} is out at ${context(i)}`)
      }
    }

    // The generator must actually be exercising both paths, or the property is vacuous.
    assert.ok(committed > 80, `too few entries committed (${committed}); the generator is not working`)
    assert.ok(refused > 10, `too few entries refused (${refused}); the illegal path is not exercised`)

    // And the projection still agrees with a full replay of everything that was generated.
    const report = await rebuildBalances(db())
    assert.equal(report.clean, true, `projection drifted: ${JSON.stringify(report.mismatches)}`)
  },
)

test('PROPERTY: reversals preserve the property too', { skip }, async () => {
  const seed = 0xbeef_0007
  const random = rng(seed)
  const posted: string[] = []

  await seedOpeningBalances(10_000_000n)

  for (let i = 0; i < 40; i++) {
    const request = generateEntry(random)
    try {
      const outcome = await postEntry(deps(), request, requestFingerprint(request as unknown))
      posted.push(outcome.result.id)
    } catch (err) {
      assert.ok(err instanceof InsufficientFundsError, String(err))
    }

    // Reverse an arbitrary earlier entry roughly half the time, including entries that are
    // themselves reversals — which must be legal and must land back on the original postings.
    if (posted.length > 2 && random() < 0.5) {
      const target = pick(random, posted)
      try {
        const reversal = await reverseEntryById(
          deps(),
          target,
          {
            originatingService: 'ops',
            actor: 'operator:prop',
            correlationId: `rev-${freshKey()}`,
            idempotencyKey: freshKey('rev'),
          },
          requestFingerprint({ target, n: i }),
        )
        posted.push(reversal.result.id)
      } catch (err) {
        assert.ok(err instanceof InsufficientFundsError, String(err))
      }
    }

    const balance = await trialBalance(db())
    assert.equal(balance.totalAbsoluteDelta, '0', `seed=${seed} iteration=${i}`)
  }

  const report = await rebuildBalances(db())
  assert.equal(report.clean, true, `projection drifted: ${JSON.stringify(report.mismatches)}`)
})
