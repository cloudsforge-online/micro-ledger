/**
 * Shared setup for the database tests.
 *
 * **A database test runs only against a database whose name says it is a test database.** That is
 * not a convenience: `resetLedger` truncates every table in the schema, and requiring "test" in the
 * name is the difference between a red build and an emptied environment. The ledger is the one
 * service in the estate where running a test suite against the wrong database would destroy the
 * record of every movement of money the platform has ever made.
 *
 * Not a test file itself — it is excluded from the build and contains no `test()` call.
 */

import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import type { AccountPurpose, AccountType, LedgerAssetCode } from '@cloudsforge/contracts-money'
import { MIGRATIONS } from './migrations.ts'
import { ensureAccount, type AccountRecord } from './accounts.ts'
import type { Db } from './outbox.ts'
import type { PostEntryRequest, PostingRequest } from './entries.ts'

const url = process.env['LEDGER_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set LEDGER_TEST_DATABASE_URL (name must contain "test")'

/**
 * Every table the ledger owns **that holds test data**, in an order that does not matter because
 * CASCADE is used.
 *
 * **`chain_assets` is deliberately absent.** It is reference data seeded by migration 11, not
 * per-test state: truncating it would empty the list the reconciliation trigger consults, and every
 * later test would then pass because the guard had nothing to match against — a whole suite going
 * green by erasing the thing it exists to check. Adding it here is the single most plausible way to
 * make this file lie.
 */
const ALL_TABLES = [
  'postings',
  'journal_entries',
  'balances',
  'balances_shadow',
  'accounts',
  'idempotency_keys',
  'asset_freezes',
  'reconciliation_runs',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
  'inbox',
  'jobs',
].join(', ')

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraint triggers drift out of the tests that are supposed to prove they fire —
 * which for this service would make the entire suite decorative.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'ledger-test' })
}

/**
 * Empty every table.
 *
 * TRUNCATE rather than DELETE: the immutability trigger on `postings` refuses DELETE, by design,
 * so a suite that tried to clean up row-by-row could not run twice. TRUNCATE does not fire row
 * triggers, which is exactly why the migration also revokes it from PUBLIC — the test harness is
 * the table owner, and nothing else is.
 */
export async function resetLedger(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${ALL_TABLES} restart identity cascade`)
}

/* ------------------------------------------------------------------ account fixtures */

export const ALICE = 'user:11111111-1111-4111-8111-111111111111'
export const BOB = 'user:22222222-2222-4222-8222-222222222222'

/** The user's spendable liability account. A credit increases it; a debit spends it. */
export function userAccount(
  subject: string,
  assetCode: LedgerAssetCode = 'SHARD',
  purpose: AccountPurpose = 'available',
): NonNullable<PostingRequest['account']> {
  return { subject: subject as never, assetCode, purpose, type: 'liability' as AccountType }
}

/** What we hold on chain. A debit increases it — see `normalBalance`. */
export function custodyAccount(assetCode: LedgerAssetCode = 'SHARD'): NonNullable<PostingRequest['account']> {
  return { subject: 'custody', assetCode, purpose: 'treasury', type: 'asset' as AccountType }
}

export function platformFeeAccount(assetCode: LedgerAssetCode = 'SHARD'): NonNullable<PostingRequest['account']> {
  return { subject: 'platform', assetCode, purpose: 'fees', type: 'revenue' as AccountType }
}

export function ensure(sql: Db, account: NonNullable<PostingRequest['account']>): Promise<AccountRecord> {
  return ensureAccount(sql, account)
}

/* ------------------------------------------------------------------ entry fixtures */

let counter = 0

/** A unique idempotency key per call, so tests never collide on a reused key by accident. */
export function freshKey(prefix = 'k'): string {
  counter += 1
  return `${prefix}-${process.pid}-${Date.now()}-${counter}`
}

/**
 * The canonical deposit: debit custody (an asset goes up), credit the user (our liability goes
 * up). It balances because those are the same number — the whole double-entry system in one entry.
 */
export function depositEntry(options: {
  subject?: string
  amount: bigint
  assetCode?: LedgerAssetCode
  idempotencyKey?: string
  originatingService?: string
  kind?: PostEntryRequest['kind']
}): PostEntryRequest {
  const assetCode = options.assetCode ?? 'SHARD'
  const subject = options.subject ?? ALICE
  return {
    kind: options.kind ?? 'deposit_credited',
    originatingService: options.originatingService ?? 'wallet',
    actor: 'system',
    correlationId: `corr-${freshKey()}`,
    idempotencyKey: options.idempotencyKey ?? freshKey(),
    postings: [
      {
        account: custodyAccount(assetCode),
        direction: 'debit',
        amount: options.amount,
        assetCode,
        sequence: 0,
      },
      {
        account: userAccount(subject, assetCode),
        direction: 'credit',
        amount: options.amount,
        assetCode,
        sequence: 1,
      },
    ],
  }
}

/** The mirror: the user spends, custody falls. Used to drive a liability towards zero. */
export function withdrawalEntry(options: {
  subject?: string
  amount: bigint
  assetCode?: LedgerAssetCode
  idempotencyKey?: string
  kind?: PostEntryRequest['kind']
}): PostEntryRequest {
  const assetCode = options.assetCode ?? 'SHARD'
  const subject = options.subject ?? ALICE
  return {
    kind: options.kind ?? 'withdrawal_requested',
    originatingService: 'wallet',
    actor: 'system',
    correlationId: `corr-${freshKey()}`,
    idempotencyKey: options.idempotencyKey ?? freshKey(),
    postings: [
      {
        account: userAccount(subject, assetCode),
        direction: 'debit',
        amount: options.amount,
        assetCode,
        sequence: 0,
      },
      {
        account: custodyAccount(assetCode),
        direction: 'credit',
        amount: options.amount,
        assetCode,
        sequence: 1,
      },
    ],
  }
}
