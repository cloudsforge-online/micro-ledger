/**
 * The chart of accounts.
 *
 * Every unit of value in the platform sits in exactly one account, and an account is identified by
 * `(subject, asset_code, purpose)` — nothing else. 04-domain-model.md §2.1: "That single fact is
 * what lets a user balance, a community treasury, a marketplace escrow and a platform revenue line
 * all live in one double-entry system with no special cases."
 *
 * **The available/reserved split is two accounts, not two columns.** Reserving funds is a posting
 * from `available` to `reserved`, which makes a reservation auditable, reversible and impossible to
 * lose track of. Today no reservation concept exists at all, so a marketplace listing holds nothing
 * and one balance can be spent twice.
 *
 * Nothing in this file decides what an account is *for*. `type` is supplied by the caller on
 * creation and never inferred, because inferring it would be the ledger adopting an accounting
 * policy it has no business owning: `platform` is revenue under `fees`, equity under `treasury`
 * and expense under `payout_due`, and a rule that guesses would be wrong for two of the three.
 */

import {
  type AccountIdentity,
  type AccountPurpose,
  type AccountStatus,
  type AccountSubject,
  type AccountType,
  type LedgerAssetCode,
  accountKey,
  parseAccountSubject,
} from '@cloudsforge/contracts-money'
import type { Db, Tx } from './outbox.ts'

/** An account as this service stores it. `id` is assigned by the database. */
export interface AccountRecord extends AccountIdentity {
  readonly id: string
  readonly type: AccountType
  readonly status: AccountStatus
  readonly overdraftAllowed: boolean
  readonly createdAt: string
}

export interface AccountRow {
  readonly id: string
  readonly subject: string
  readonly type: string
  readonly asset_code: string
  readonly purpose: string
  readonly status: string
  readonly overdraft_allowed: boolean
  readonly created_at: Date
}

export function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    subject: row.subject as AccountSubject,
    assetCode: row.asset_code as LedgerAssetCode,
    purpose: row.purpose as AccountPurpose,
    type: row.type as AccountType,
    status: row.status as AccountStatus,
    overdraftAllowed: row.overdraft_allowed,
    createdAt: row.created_at.toISOString(),
  }
}

/** Raised when an account is named that does not exist and cannot be created. */
export class UnknownAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownAccountError'
  }
}

/** Raised when a caller's stated `type` disagrees with the account that already exists. */
export class AccountConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountConflictError'
  }
}

export interface EnsureAccountInput extends AccountIdentity {
  readonly type: AccountType
  /**
   * Only `clearing` and `suspense` accounts get this. A user liability going negative means we
   * have paid out value the user never had, which must fail loudly at the posting rather than be
   * discovered at the month end.
   */
  readonly overdraftAllowed?: boolean
}

/**
 * Find an account by its key, or create it.
 *
 * `on conflict do nothing` then re-select, rather than `on conflict do update`: two concurrent
 * callers ensuring the same account must both end up with the one row, and neither must be able to
 * change the other's `type` or `overdraft_allowed` as a side effect of merely referring to it.
 * Silently widening an existing account's overdraft permission from a posting call is how a user
 * liability quietly becomes allowed to go negative.
 */
export async function ensureAccount(sql: Db | Tx, input: EnsureAccountInput): Promise<AccountRecord> {
  // Validates the subject's shape and, for a `user:`/`community:`/`organisation:` subject, that
  // the id contains neither ':' nor the key delimiter. Two distinct accounts producing one key is
  // the quietest possible way to merge two users' balances.
  parseAccountSubject(input.subject)
  accountKey(input)

  const overdraft = input.overdraftAllowed ?? false

  await sql`
    insert into accounts (subject, type, asset_code, purpose, overdraft_allowed)
    values (${input.subject}, ${input.type}, ${input.assetCode}, ${input.purpose}, ${overdraft})
    on conflict (subject, asset_code, purpose) do nothing
  `

  const existing = await findAccount(sql, input)
  if (!existing) {
    // Unreachable unless the row was deleted between the insert and the read. Accounts are never
    // deleted, so this is a genuine "should not happen" rather than a race to paper over.
    throw new UnknownAccountError(`account ${accountKey(input)} could not be created or read`)
  }

  // A caller that names an existing account with a different type has misunderstood the chart, and
  // continuing would post a debit in the direction the caller expected rather than the direction
  // the account actually normalises to — a wrong balance that still balances.
  if (existing.type !== input.type) {
    throw new AccountConflictError(
      `account ${accountKey(input)} already exists as ${existing.type}, not ${input.type}`,
    )
  }

  return existing
}

export async function findAccount(sql: Db | Tx, identity: AccountIdentity): Promise<AccountRecord | null> {
  const rows = await sql<AccountRow[]>`
    select id, subject, type, asset_code, purpose, status, overdraft_allowed, created_at
      from accounts
     where subject = ${identity.subject}
       and asset_code = ${identity.assetCode}
       and purpose = ${identity.purpose}
  `
  const row = rows[0]
  return row ? toAccount(row) : null
}

export async function findAccountById(sql: Db | Tx, id: string): Promise<AccountRecord | null> {
  const rows = await sql<AccountRow[]>`
    select id, subject, type, asset_code, purpose, status, overdraft_allowed, created_at
      from accounts
     where id = ${id}
  `
  const row = rows[0]
  return row ? toAccount(row) : null
}

/** One account's balance in the projection. */
export interface BalanceView {
  readonly accountId: string
  readonly subject: AccountSubject
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
  readonly status: AccountStatus
  /**
   * In the account's own normal direction, so it is "how much of this account there is" for both
   * a liability and an asset. Rendered as a decimal string, never a JSON number: a Shard balance
   * fits in a double but an 18-decimal EMBER balance does not, and a balance that silently loses
   * its low bits in transit is worse than one that fails to serialise.
   */
  readonly amount: string
  readonly asOfEntryId: string | null
  readonly updatedAt: string | null
}

interface BalanceRow {
  readonly account_id: string
  readonly subject: string
  readonly asset_code: string
  readonly purpose: string
  readonly type: string
  readonly status: string
  readonly amount: string
  readonly as_of_entry_id: string | null
  readonly updated_at: Date | null
}

/**
 * Every balance a subject holds, across assets and purposes.
 *
 * A left join, so an account that exists but has never been posted to reports `0` rather than
 * being absent. "No row" and "zero" are the same fact to a caller and different facts to a
 * consumer that has to decide whether to show a line; making the ledger answer it removes the
 * question from every product that asks.
 */
export async function balancesForSubject(sql: Db, subject: string): Promise<BalanceView[]> {
  parseAccountSubject(subject)
  const rows = await sql<BalanceRow[]>`
    select a.id            as account_id,
           a.subject       as subject,
           a.asset_code    as asset_code,
           a.purpose       as purpose,
           a.type          as type,
           a.status        as status,
           coalesce(b.amount, 0)::text as amount,
           b.as_of_entry_id,
           b.updated_at
      from accounts a
      left join balances b
        on b.account_id = a.id and b.asset_code = a.asset_code
     where a.subject = ${subject}
     order by a.asset_code, a.purpose
  `
  return rows.map((row) => ({
    accountId: row.account_id,
    subject: row.subject as AccountSubject,
    assetCode: row.asset_code as LedgerAssetCode,
    purpose: row.purpose as AccountPurpose,
    type: row.type as AccountType,
    status: row.status as AccountStatus,
    amount: row.amount,
    asOfEntryId: row.as_of_entry_id,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  }))
}
