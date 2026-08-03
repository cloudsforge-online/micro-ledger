/**
 * The posting API: journal entries, postings, reversals and reservations.
 *
 * **This file contains no business rule and must never acquire one.** AD-06: the ledger does not
 * know what a cosmetic costs, what a listing is worth or when a subscription renews. It accepts
 * typed postings from an identified caller and enforces that they balance. Every temptation to add
 * "if kind is purchase then also…" belongs in the service that owns the product decision, because
 * a ledger owned by one product acquires that product's assumptions and then cannot be the source
 * of truth for the other six.
 *
 * What this file *does* own:
 *
 *   * The transaction boundary. The idempotency claim, the entry, its postings, the balance
 *     projection and the outbox row all commit together or not at all.
 *   * Translating the database's invariant violations into diagnoses a caller can act on.
 *   * Refusing to post at all when reconciliation has frozen the asset for withdrawals.
 *
 * The arithmetic itself — balancing, the sign convention, reversal, reservation pairs — is
 * `@cloudsforge/contracts-money` and is not reimplemented here. A second copy of `normalBalance`
 * is a second place for the direction of a liability to be got backwards.
 */

import {
  type Actor,
  type Direction,
  type EntryKind,
  type EntryMetadata,
  type JournalEntry,
  type LedgerAssetCode,
  type Posting,
  type Timestamp,
  balanceEntry,
  describeBalanceProblem,
  increasesBalance,
  isEntryKind,
  releasePostings,
  reservePostings,
  reverseEntry,
} from '@cloudsforge/contracts-money'
import {
  type AccountRecord,
  type EnsureAccountInput,
  AccountConflictError,
  UnknownAccountError,
  ensureAccount,
  findAccountById,
} from './accounts.ts'
import { withIdempotency, type IdempotentOutcome } from './idempotency.ts'
import { isUuid, uuidv7 } from './ids.ts'
import type { Db, Tx } from './outbox.ts'

/* ------------------------------------------------------------------------ errors */

/** The request could not be turned into a legal entry. 400. */
export class LedgerValidationError extends Error {
  readonly problems: readonly string[]
  constructor(message: string, problems: readonly string[] = []) {
    super(message)
    this.name = 'LedgerValidationError'
    this.problems = problems
  }
}

/** The database refused the entry because it does not balance. 400, and a bug in the caller. */
export class UnbalancedEntryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnbalancedEntryError'
  }
}

/** A liability would have gone negative. 409 — the caller may not spend what is not there. */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientFundsError'
  }
}

/** Reconciliation drift exceeded tolerance for this asset. Withdrawals are frozen. 409. */
export class AssetFrozenError extends Error {
  readonly assetCode: string
  readonly reason: string
  constructor(assetCode: string, reason: string) {
    super(`withdrawals in ${assetCode} are frozen: ${reason}`)
    this.name = 'AssetFrozenError'
    this.assetCode = assetCode
    this.reason = reason
  }
}

/** The account exists but may not be posted to. 409. */
export class AccountNotPostableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountNotPostableError'
  }
}

/** Something that must exist does not. 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** An append-only table was asked to change. Only reachable from a bug or a psql session. */
export class ImmutableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImmutableError'
  }
}

/* ------------------------------------------------------------------------ request shapes */

/**
 * One side of a movement, as a caller states it.
 *
 * An account is named either by `accountId` or by its key. The key form exists because a caller
 * such as `wallet` knows "user:X's available SHARD account" and not a UUID, and making it look the
 * id up first would be a round trip plus a race with the account's creation.
 */
export interface PostingRequest {
  readonly accountId?: string
  /**
   * `type` is required when the account may not exist yet. It is never inferred: `platform` is
   * revenue under `fees`, equity under `treasury` and expense under `payout_due`, so a rule that
   * guessed would be wrong for two of the three.
   */
  readonly account?: EnsureAccountInput
  readonly direction: Direction
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly description?: string
  /** Which service posted this. Present on every entry — this is what makes revenue attributable. */
  readonly originatingService: string
  readonly actor: Actor
  readonly correlationId: string
  /** The caller's key. Namespaced by `originatingService` before it is stored. */
  readonly idempotencyKey: string
  readonly occurredAt?: Timestamp
  readonly metadata?: EntryMetadata
  readonly reversesEntryId?: string
  readonly postings: readonly PostingRequest[]
}

/** A posting as it is returned. `amount` is a decimal string; see `EntryView`. */
export interface PostingView {
  readonly id: string
  readonly accountId: string
  readonly direction: Direction
  readonly amount: string
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
}

/**
 * An entry as it is returned and as it is stored in the idempotency replay.
 *
 * Amounts are decimal **strings**, never JSON numbers. An 18-decimal EMBER amount exceeds
 * `Number.MAX_SAFE_INTEGER` by twelve orders of magnitude, and a balance that silently loses its
 * low bits crossing a JSON boundary is precisely the class of quiet wrong number this service
 * exists to make impossible.
 */
export interface EntryView {
  readonly id: string
  readonly kind: EntryKind
  readonly description: string | null
  readonly originatingService: string
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly reversesEntryId: string | null
  readonly occurredAt: string
  readonly recordedAt: string
  readonly metadata: EntryMetadata
  readonly postings: readonly PostingView[]
}

/**
 * The topic a posted entry announces itself on.
 *
 * Named rather than inlined into the SQL below, for a reason `micro-org`'s estate checker had to
 * learn the hard way: this event is written by a **raw `insert into outbox (topic, …) values (…)`**
 * and not through a `topic:` property, so a grep for the emit-site shape finds nothing here and
 * reports the service as emitting no events at all. A constant makes the name reachable from
 * `topics.ts`, which is what lets the guard reconcile it against the registry in both directions.
 *
 * FIRST of the eight topics of 02-target-architecture §5, keyed by the account of the first posting,
 * and the only source of per-product revenue.
 */
export const ENTRY_POSTED = 'ledger.entry.posted'

/**
 * The entry kinds that reconciliation's freeze blocks.
 *
 * `withdrawal_refunded` is deliberately absent. A refund returns value to the user; blocking it
 * during a freeze would harm the party the freeze exists to protect, and would strand money in a
 * clearing account for as long as the drift takes to resolve. The freeze stops value LEAVING the
 * platform, which is `withdrawal_requested` and `withdrawal_settled`.
 */
export const WITHDRAWAL_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>([
  'withdrawal_requested',
  'withdrawal_settled',
])

/**
 * Kinds permitted to post to a `frozen` account.
 *
 * An operator freezes an account to stop ordinary movement, not to make it uncorrectable. If a
 * freeze blocked corrections too, the only way to fix a wrong balance on a frozen account would be
 * to unfreeze it first — which is the moment the wrong balance is spendable.
 */
const CORRECTION_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>([
  'adjustment',
  'reconciliation_correction',
  'reversal',
])

/* ------------------------------------------------------------------------ error mapping */

interface PgError {
  readonly code?: string
  readonly message?: string
  readonly constraint_name?: string
}

/**
 * Turn a database invariant violation into a typed error.
 *
 * The database is the enforcement point (04-domain-model.md §2.2), so these are not redundant
 * checks — they are the *only* checks for anything that reaches the tables by another route, and
 * the application must be able to say which one fired. Matching on the message text is deliberate:
 * every message below is raised by a trigger defined in `migrations.ts` in this same repository,
 * so the coupling is internal and both halves change together.
 */
export function mapDatabaseError(err: unknown): unknown {
  const pg = err as PgError
  const message = pg?.message ?? ''

  if (pg?.constraint_name === 'journal_entries_idempotency_key_uniq') {
    // Reachable only if a caller bypassed `withIdempotency`, or if two entries were built with the
    // same key inside one request. Either way the entry is refused rather than duplicated.
    return new LedgerValidationError('that idempotency key has already produced an entry')
  }
  if (/does not balance|has no postings/.test(message)) {
    return new UnbalancedEntryError(message)
  }
  if (/may not go negative/.test(message)) {
    return new InsufficientFundsError(message)
  }
  if (/append-only/.test(message)) {
    return new ImmutableError(message)
  }
  return err
}

/* ------------------------------------------------------------------------ posting */

function reference(posting: PostingRequest, index: number): string {
  if (posting.accountId) return posting.accountId
  const account = posting.account
  return account ? `${account.subject}|${account.assetCode}|${account.purpose}` : `posting[${index}]`
}

/**
 * Everything that can be checked without touching the database.
 *
 * Run before the transaction opens so a malformed request costs nothing, and so the caller gets
 * `balanceEntry`'s typed diagnosis — which asset is out and by how much — rather than the
 * database's single-line exception.
 */
export function validateEntryRequest(request: PostEntryRequest): void {
  if (!isEntryKind(request.kind)) {
    throw new LedgerValidationError(`unknown entry kind: ${String(request.kind)}`)
  }
  if (!request.originatingService) throw new LedgerValidationError('originatingService is required')
  if (!request.actor) throw new LedgerValidationError('actor is required')
  if (!request.correlationId) throw new LedgerValidationError('correlationId is required')
  if (!request.idempotencyKey) throw new LedgerValidationError('idempotencyKey is required')
  if (request.reversesEntryId !== undefined && !isUuid(request.reversesEntryId)) {
    throw new LedgerValidationError('reversesEntryId must be a uuid')
  }

  for (const [index, posting] of request.postings.entries()) {
    if (!posting.accountId && !posting.account) {
      throw new LedgerValidationError(`posting ${index} names no account`)
    }
    if (posting.accountId && !isUuid(posting.accountId)) {
      throw new LedgerValidationError(`posting ${index} accountId must be a uuid`)
    }
  }

  // The application-level statement of the same invariant the deferred trigger enforces. It exists
  // for the error message, not for the safety: a test posts an unbalanced entry straight to the
  // tables to prove the database refuses it with this check nowhere in the path.
  const check = balanceEntry(
    request.postings.map((posting, index) => ({
      accountId: reference(posting, index),
      direction: posting.direction,
      amount: posting.amount,
      assetCode: posting.assetCode,
      sequence: posting.sequence,
    })),
  )
  if (!check.ok) {
    throw new LedgerValidationError(
      'entry does not balance',
      check.problems.map(describeBalanceProblem),
    )
  }
}

/** Resolve every posting's account, creating those named by key that do not exist yet. */
async function resolveAccounts(tx: Tx, request: PostEntryRequest): Promise<AccountRecord[]> {
  const resolved: AccountRecord[] = []

  for (const [index, posting] of request.postings.entries()) {
    let account: AccountRecord | null
    if (posting.accountId) {
      account = await findAccountById(tx, posting.accountId)
      if (!account) throw new UnknownAccountError(`posting ${index}: no account ${posting.accountId}`)
    } else {
      account = await ensureAccount(tx, posting.account!)
    }

    // An asset mismatch is the transposition `accountKey` warns about, arriving one layer later:
    // the postings would balance per asset while crediting an account denominated in another.
    if (account.assetCode !== posting.assetCode) {
      throw new LedgerValidationError(
        `posting ${index} is ${posting.assetCode} but account ${account.id} is ${account.assetCode}`,
      )
    }
    if (account.status === 'closed') {
      throw new AccountNotPostableError(`account ${account.id} is closed`)
    }
    if (account.status === 'frozen' && !CORRECTION_KINDS.has(request.kind)) {
      throw new AccountNotPostableError(
        `account ${account.id} is frozen; only ${[...CORRECTION_KINDS].join(', ')} may post to it`,
      )
    }
    resolved.push(account)
  }

  return resolved
}

/**
 * Refuse a withdrawal in an asset whose reconciliation drift exceeded tolerance.
 *
 * Read inside the posting transaction, not cached. A freeze set by the reconciliation job while
 * this request was in flight must take effect on this request: the whole point is that the ledger
 * stops paying out the moment it stops being able to prove it holds what it owes.
 */
async function assertNotFrozen(tx: Tx, request: PostEntryRequest): Promise<void> {
  if (!WITHDRAWAL_KINDS.has(request.kind)) return

  const assets = [...new Set(request.postings.map((p) => p.assetCode))]
  const rows = await tx<{ asset_code: string; reason: string }[]>`
    select asset_code, reason from asset_freezes where asset_code = any(${assets as string[]})
  `
  const frozen = rows[0]
  if (frozen) throw new AssetFrozenError(frozen.asset_code, frozen.reason)
}

/** Write the entry, its postings and the balance movements. Returns the stored view. */
async function writeEntry(
  tx: Tx,
  request: PostEntryRequest,
  storedKey: string,
  producer: string,
): Promise<EntryView> {
  const accounts = await resolveAccounts(tx, request)
  await assertNotFrozen(tx, request)

  const entryId = uuidv7()
  const occurredAt = request.occurredAt ?? new Date().toISOString()
  const metadata = request.metadata ?? {}

  if (request.reversesEntryId) {
    const exists = await tx<{ id: string }[]>`
      select id from journal_entries where id = ${request.reversesEntryId}
    `
    if (exists.length === 0) {
      throw new NotFoundError(`no entry ${request.reversesEntryId} to reverse`)
    }
  }

  const entryRows = await tx<{ recorded_at: Date; occurred_at: Date }[]>`
    insert into journal_entries (
      id, kind, description, originating_service, actor, correlation_id,
      idempotency_key, reverses_entry_id, occurred_at, metadata
    ) values (
      ${entryId}, ${request.kind}, ${request.description ?? null}, ${request.originatingService},
      ${request.actor}, ${request.correlationId}, ${storedKey},
      ${request.reversesEntryId ?? null}, ${occurredAt}::timestamptz,
      ${tx.json(metadata as Record<string, never>)}
    )
    returning recorded_at, occurred_at
  `
  const entryRow = entryRows[0]
  if (!entryRow) throw new Error('entry insert returned no row')

  const postings: PostingView[] = []
  for (const [index, posting] of request.postings.entries()) {
    const account = accounts[index]!
    // Amounts cross the driver as strings with an explicit cast. A JS number would silently round
    // anything above 2^53, and this is the one column in the estate where that is unrecoverable.
    const rows = await tx<{ id: string }[]>`
      insert into postings (entry_id, account_id, direction, amount, asset_code, sequence)
      values (
        ${entryId}, ${account.id}, ${posting.direction},
        ${posting.amount.toString()}::numeric(78,0), ${posting.assetCode}, ${posting.sequence}
      )
      returning id
    `
    const row = rows[0]
    if (!row) throw new Error('posting insert returned no row')
    postings.push({
      id: row.id,
      accountId: account.id,
      direction: posting.direction,
      amount: posting.amount.toString(),
      assetCode: posting.assetCode,
      sequence: posting.sequence,
    })
  }

  await applyToBalances(tx, entryId, request, accounts)

  await tx`
    insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
    values (
      ${ENTRY_POSTED},
      ${entryId},
      ${producer},
      1,
      ${request.actor},
      ${request.correlationId},
      ${tx.json({
        entryId,
        kind: request.kind,
        originatingService: request.originatingService,
        assets: [...new Set(request.postings.map((p) => p.assetCode))],
      } as unknown as Record<string, never>)}
    )
  `

  return {
    id: entryId,
    kind: request.kind,
    description: request.description ?? null,
    originatingService: request.originatingService,
    actor: request.actor,
    correlationId: request.correlationId,
    idempotencyKey: storedKey,
    reversesEntryId: request.reversesEntryId ?? null,
    occurredAt: entryRow.occurred_at.toISOString(),
    recordedAt: entryRow.recorded_at.toISOString(),
    metadata,
    postings,
  }
}

/**
 * Fold the entry's postings into the balances projection.
 *
 * Two details carry the concurrency correctness:
 *
 *   1. **Deltas are netted per (account, asset) first.** An entry may touch one account twice, and
 *      two upserts against one row inside one statement-sequence would each read the pre-image.
 *   2. **Rows are applied in sorted order.** Two transactions posting to the same pair of accounts
 *      in opposite orders deadlock; a total order over `(account_id, asset_code)` means every
 *      transaction takes the same locks in the same sequence, so one waits instead.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` re-reads the winning tuple after taking its row lock, so the
 * `balances.amount + delta` is computed against the other transaction's committed value rather
 * than a stale snapshot. That is what makes N concurrent debits against one liability serialise —
 * and it is why the overdraft trigger, which is immediate, sees a true running balance.
 */
async function applyToBalances(
  tx: Tx,
  entryId: string,
  request: PostEntryRequest,
  accounts: readonly AccountRecord[],
): Promise<void> {
  const deltas = new Map<string, { accountId: string; assetCode: string; delta: bigint }>()

  for (const [index, posting] of request.postings.entries()) {
    const account = accounts[index]!
    const key = `${account.id}|${posting.assetCode}`
    // The sign convention lives in contracts-money and is applied here, once. A second copy of it
    // is a second opportunity to make a credit decrease a liability.
    const signed = increasesBalance(posting.direction, account.type) ? posting.amount : -posting.amount
    const existing = deltas.get(key)
    if (existing) existing.delta += signed
    else deltas.set(key, { accountId: account.id, assetCode: posting.assetCode, delta: signed })
  }

  const ordered = [...deltas.values()].sort((a, b) =>
    a.accountId === b.accountId
      ? a.assetCode.localeCompare(b.assetCode)
      : a.accountId.localeCompare(b.accountId),
  )

  for (const movement of ordered) {
    await tx`
      insert into balances (account_id, asset_code, amount, as_of_entry_id, updated_at)
      values (
        ${movement.accountId}, ${movement.assetCode},
        ${movement.delta.toString()}::numeric(78,0), ${entryId}, now()
      )
      on conflict (account_id, asset_code) do update
        set amount = balances.amount + excluded.amount,
            as_of_entry_id = excluded.as_of_entry_id,
            updated_at = now()
    `
  }
}

export interface PostEntryDeps {
  readonly sql: Db
  readonly producer: string
}

/**
 * Post an entry.
 *
 * The idempotency claim, the entry, its postings, the projection and the outbox row are one
 * transaction. The deferred balancing trigger fires at its COMMIT, so an entry that does not
 * balance takes all of them down with it — including the idempotency claim, which is what stops a
 * failed post from poisoning its own retry.
 */
export async function postEntry(
  deps: PostEntryDeps,
  request: PostEntryRequest,
  requestHash: string,
): Promise<IdempotentOutcome<EntryView>> {
  validateEntryRequest(request)

  try {
    return await withIdempotency<EntryView>(deps.sql, {
      originatingService: request.originatingService,
      route: 'POST /entries',
      clientKey: request.idempotencyKey,
      requestHash,
      run: async (tx, storedKey) => {
        const view = await writeEntry(tx, request, storedKey, deps.producer)
        return { response: view, entryId: view.id }
      },
    })
  } catch (err) {
    throw mapDatabaseError(err)
  }
}

/* ------------------------------------------------------------------------ reading */

interface EntryRow {
  readonly id: string
  readonly kind: string
  readonly description: string | null
  readonly originating_service: string
  readonly actor: string
  readonly correlation_id: string
  readonly idempotency_key: string
  readonly reverses_entry_id: string | null
  readonly occurred_at: Date
  readonly recorded_at: Date
  readonly metadata: EntryMetadata
}

interface PostingRow {
  readonly id: string
  readonly entry_id: string
  readonly account_id: string
  readonly direction: string
  readonly amount: string
  readonly asset_code: string
  readonly sequence: number
}

function toEntryView(row: EntryRow, postings: readonly PostingRow[]): EntryView {
  return {
    id: row.id,
    kind: row.kind as EntryKind,
    description: row.description,
    originatingService: row.originating_service,
    actor: row.actor as Actor,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    reversesEntryId: row.reverses_entry_id,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    metadata: row.metadata,
    postings: postings
      .filter((p) => p.entry_id === row.id)
      .map((p) => ({
        id: p.id,
        accountId: p.account_id,
        direction: p.direction as Direction,
        amount: p.amount,
        assetCode: p.asset_code as LedgerAssetCode,
        sequence: p.sequence,
      })),
  }
}

export async function readEntry(sql: Db | Tx, entryId: string): Promise<EntryView | null> {
  if (!isUuid(entryId)) throw new LedgerValidationError('entry id must be a uuid')
  const rows = await sql<EntryRow[]>`
    select id, kind, description, originating_service, actor, correlation_id, idempotency_key,
           reverses_entry_id, occurred_at, recorded_at, metadata
      from journal_entries where id = ${entryId}
  `
  const row = rows[0]
  if (!row) return null
  const postings = await sql<PostingRow[]>`
    select id, entry_id, account_id, direction, amount::text as amount, asset_code, sequence
      from postings where entry_id = ${entryId} order by sequence
  `
  return toEntryView(row, postings)
}

export interface ListEntriesQuery {
  readonly limit: number
  /** Keyset cursor: the `id` of the last entry of the previous page. */
  readonly cursor?: string
  readonly kind?: EntryKind
  readonly originatingService?: string
  readonly correlationId?: string
}

export interface EntryPage {
  readonly entries: readonly EntryView[]
  /** Absent on the last page. Callers page until it is missing, never by counting. */
  readonly nextCursor: string | null
}

export const MAX_PAGE_SIZE = 200
export const DEFAULT_PAGE_SIZE = 50

/**
 * A page of the journal.
 *
 * **Keyset pagination on `id`, not `offset`.** Two reasons, and the second is the one that
 * matters: an OFFSET scan re-reads and discards every preceding row, so page 500 of an append-only
 * journal costs 500 pages of work; and because the journal is written to continuously, an OFFSET
 * page boundary shifts under a caller between requests and silently skips entries. `id` is UUIDv7,
 * so ordering by it descending is reverse chronological order with no tie-break ambiguity.
 *
 * The existing wallet returns the entire unpaginated ledger on every call. That is a defect worth
 * not repeating: it is unbounded memory on the server, unbounded transfer, and it gets slower for
 * every user every day for ever.
 */
export async function listEntries(sql: Db, query: ListEntriesQuery): Promise<EntryPage> {
  const limit = Math.min(Math.max(1, query.limit), MAX_PAGE_SIZE)
  if (query.cursor !== undefined && !isUuid(query.cursor)) {
    throw new LedgerValidationError('cursor must be a uuid')
  }
  if (query.kind !== undefined && !isEntryKind(query.kind)) {
    throw new LedgerValidationError(`unknown entry kind: ${String(query.kind)}`)
  }

  // One extra row, so "is there another page" is answered without a second COUNT query over a
  // table that only ever grows.
  const rows = await sql<EntryRow[]>`
    select id, kind, description, originating_service, actor, correlation_id, idempotency_key,
           reverses_entry_id, occurred_at, recorded_at, metadata
      from journal_entries
     where (${query.cursor ?? null}::uuid is null or id < ${query.cursor ?? null}::uuid)
       and (${query.kind ?? null}::text is null or kind = ${query.kind ?? null})
       and (${query.originatingService ?? null}::text is null
            or originating_service = ${query.originatingService ?? null})
       and (${query.correlationId ?? null}::text is null
            or correlation_id = ${query.correlationId ?? null})
     order by id desc
     limit ${limit + 1}
  `

  const page = rows.slice(0, limit)
  const ids = page.map((r) => r.id)
  const postings =
    ids.length === 0
      ? []
      : await sql<PostingRow[]>`
          select id, entry_id, account_id, direction, amount::text as amount, asset_code, sequence
            from postings where entry_id = any(${ids}::uuid[]) order by entry_id, sequence
        `

  return {
    entries: page.map((row) => toEntryView(row, postings)),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}

/* ------------------------------------------------------------------------ trial balance */

export interface AssetTrialBalance {
  readonly assetCode: string
  readonly debits: string
  readonly credits: string
  /** debits − credits. **Must be exactly zero.** */
  readonly delta: string
}

export interface TrialBalance {
  readonly assets: readonly AssetTrialBalance[]
  /** True only when every asset's delta is exactly `0`. */
  readonly balanced: boolean
  /**
   * Σ |delta| over every asset. Zero iff the ledger balances, and the value behind the
   * `ledger_trial_balance_delta` metric — one number an alert can be `!= 0` on.
   */
  readonly totalAbsoluteDelta: string
  readonly entryCount: number
  readonly postingCount: number
}

/**
 * Σ debits − Σ credits, per asset, over the whole journal. It must be exactly zero.
 *
 * This is the panel 02-target-architecture.md §6.2 monitors, and it is the one number that says
 * whether the ledger is internally consistent. It is computed by the database summing
 * `numeric(78,0)` — not by reading rows into the application and adding them up, which would put
 * the answer at the mercy of the same arithmetic it is checking.
 *
 * A non-zero result is a P0. It should be unreachable: the deferred trigger makes every entry
 * balance, and a sum of balanced entries is balanced. If it is ever non-zero, either a trigger was
 * dropped or something wrote to `postings` outside this service.
 */
export async function trialBalance(sql: Db): Promise<TrialBalance> {
  const rows = await sql<{ asset_code: string; debits: string; credits: string; delta: string }[]>`
    select asset_code,
           coalesce(sum(amount) filter (where direction = 'debit'), 0)::text  as debits,
           coalesce(sum(amount) filter (where direction = 'credit'), 0)::text as credits,
           (coalesce(sum(amount) filter (where direction = 'debit'), 0)
            - coalesce(sum(amount) filter (where direction = 'credit'), 0))::text as delta
      from postings
     group by asset_code
     order by asset_code
  `

  const counts = await sql<{ entries: number; postings: number }[]>`
    select (select count(*)::int from journal_entries) as entries,
           (select count(*)::int from postings)        as postings
  `

  let total = 0n
  for (const row of rows) {
    const delta = BigInt(row.delta)
    total += delta < 0n ? -delta : delta
  }

  return {
    assets: rows.map((row) => ({
      assetCode: row.asset_code,
      debits: row.debits,
      credits: row.credits,
      delta: row.delta,
    })),
    balanced: total === 0n,
    totalAbsoluteDelta: total.toString(),
    entryCount: counts[0]?.entries ?? 0,
    postingCount: counts[0]?.postings ?? 0,
  }
}

/* ------------------------------------------------------------------------ reversal */

export interface ReverseRequest {
  readonly originatingService: string
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly kind?: EntryKind
  readonly metadata?: EntryMetadata
}

/** The contracts-money view of a stored entry, so `reverseEntry` can mirror it. */
function toJournalEntry(view: EntryView): JournalEntry {
  const postings: Posting[] = view.postings.map((p) => ({
    accountId: p.accountId,
    direction: p.direction,
    amount: BigInt(p.amount),
    assetCode: p.assetCode,
    sequence: p.sequence,
  }))
  return {
    id: view.id,
    kind: view.kind,
    originatingService: view.originatingService,
    actor: view.actor,
    correlationId: view.correlationId,
    idempotencyKey: view.idempotencyKey,
    occurredAt: view.occurredAt,
    recordedAt: view.recordedAt,
    postings,
    ...(view.description !== null ? { description: view.description } : {}),
    ...(view.reversesEntryId !== null ? { reversesEntryId: view.reversesEntryId } : {}),
  }
}

/**
 * Reverse an entry: **a new entry, never an edit.**
 *
 * The mirroring is `reverseEntry` from contracts-money, which flips every posting and sets
 * `reversesEntryId`. Reversing a reversal is legal and lands back on the original postings, which
 * is what makes an operator's mis-click recoverable.
 *
 * The reversal is dated now, not at the original's business time: back-dating a correction moves
 * money into a period that may already have been reported and closed.
 */
export async function reverseEntryById(
  deps: PostEntryDeps,
  entryId: string,
  request: ReverseRequest,
  requestHash: string,
): Promise<IdempotentOutcome<EntryView>> {
  if (!isUuid(entryId)) throw new LedgerValidationError('entry id must be a uuid')

  const original = await readEntry(deps.sql, entryId)
  if (!original) throw new NotFoundError(`no entry ${entryId}`)

  const recordedAt = new Date().toISOString()
  const mirrored = reverseEntry(toJournalEntry(original), {
    id: uuidv7(),
    // Namespaced identically to the claim `withIdempotency` will take, so the value stored on the
    // entry and the value stored on the claim describe the same key.
    idempotencyKey: `${request.originatingService}:POST /entries/:id/reverse:${request.idempotencyKey}`,
    recordedAt,
    actor: request.actor,
    correlationId: request.correlationId,
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
  })

  const postings: PostingRequest[] = mirrored.postings.map((p) => ({
    accountId: p.accountId,
    direction: p.direction,
    amount: p.amount,
    assetCode: p.assetCode,
    sequence: p.sequence,
  }))

  try {
    return await withIdempotency<EntryView>(deps.sql, {
      originatingService: request.originatingService,
      route: 'POST /entries/:id/reverse',
      clientKey: request.idempotencyKey,
      requestHash,
      run: async (tx, storedKey) => {
        const view = await writeEntry(
          tx,
          {
            kind: mirrored.kind,
            originatingService: request.originatingService,
            actor: mirrored.actor,
            correlationId: mirrored.correlationId,
            idempotencyKey: request.idempotencyKey,
            reversesEntryId: entryId,
            occurredAt: mirrored.occurredAt,
            postings,
            ...(mirrored.description !== undefined ? { description: mirrored.description } : {}),
            ...(mirrored.metadata !== undefined ? { metadata: mirrored.metadata } : {}),
          },
          storedKey,
          deps.producer,
        )
        return { response: view, entryId: view.id }
      },
    })
  } catch (err) {
    throw mapDatabaseError(err)
  }
}

/* ------------------------------------------------------------------------ reservations */

export interface ReserveRequest {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  readonly originatingService: string
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  /**
   * The caller states why. Defaulted rather than inferred, and `transfer` is the honest default:
   * the ledger does not know whether this reservation is a marketplace listing, a withdrawal being
   * prepared or a governance timelock, and the closed set has no word that covers all three.
   */
  readonly kind?: EntryKind
  readonly metadata?: EntryMetadata
}

/**
 * Move value from a subject's `available` account to its `reserved` account.
 *
 * **A reservation is a posting pair, not a column update.** That is the whole point of modelling
 * the split as two accounts: it is auditable, reversible and impossible to lose, and a listing
 * that cannot reserve cannot be listed — which is what makes "sold twice" unrepresentable. Today
 * no reservation concept exists at all.
 *
 * The reservation's identity is the entry id. That is deliberate: there is no separate
 * reservations table to fall out of step with the journal, and "does this reservation exist" is
 * answered by the same rows that prove the money moved.
 */
export async function reserve(
  deps: PostEntryDeps,
  request: ReserveRequest,
  requestHash: string,
): Promise<IdempotentOutcome<EntryView>> {
  if (request.amount <= 0n) {
    throw new LedgerValidationError('reservation amount must be positive')
  }

  // Placeholder ids: `reservePostings` builds the pair and gets the directions right, and the
  // account keys below are resolved to real accounts inside the transaction.
  const pair = reservePostings({
    availableAccountId: 'available',
    reservedAccountId: 'reserved',
    assetCode: request.assetCode,
    amount: request.amount,
  })

  const postings: PostingRequest[] = pair.map((posting) => ({
    account: {
      subject: request.subject as EnsureAccountInput['subject'],
      assetCode: request.assetCode,
      purpose: posting.accountId === 'available' ? 'available' : 'reserved',
      // Both sides are the subject's own liability accounts, which is why the pair balances: the
      // debit leaves `available` and the credit arrives in `reserved`, and it is the same number.
      type: 'liability',
    },
    direction: posting.direction,
    amount: posting.amount,
    assetCode: posting.assetCode,
    sequence: posting.sequence,
  }))

  return postEntry(
    deps,
    {
      kind: request.kind ?? 'transfer',
      originatingService: request.originatingService,
      actor: request.actor,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      postings,
      description: request.description ?? `Reserve ${request.amount} ${request.assetCode}`,
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    },
    requestHash,
  )
}

export interface ReleaseRequest {
  readonly originatingService: string
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly kind?: EntryKind
  readonly metadata?: EntryMetadata
}

/** Raised when a reservation has already been released. 409. */
export class AlreadyReleasedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AlreadyReleasedError'
  }
}

/**
 * Return a reservation to `available`.
 *
 * **Only a full release.** A partial release is deliberately not supported: it would need a
 * running "how much of this reservation is left" that is neither in the journal nor derivable from
 * it without interpreting intent, and a caller that wants halves can make two reservations. The
 * ledger declining to model that is the ledger declining to hold a business rule.
 *
 * Double release is prevented by two independent mechanisms. The idempotency key covers a retry of
 * the same request; the `FOR UPDATE` lock on the reservation entry plus the existence check covers
 * two *different* requests racing, which no idempotency key would catch.
 */
export async function release(
  deps: PostEntryDeps,
  reservationId: string,
  request: ReleaseRequest,
  requestHash: string,
): Promise<IdempotentOutcome<EntryView>> {
  if (!isUuid(reservationId)) throw new LedgerValidationError('reservation id must be a uuid')

  try {
    return await withIdempotency<EntryView>(deps.sql, {
      originatingService: request.originatingService,
      route: 'POST /reservations/:id/release',
      clientKey: request.idempotencyKey,
      requestHash,
      run: async (tx, storedKey) => {
        // Serialises two concurrent releases of one reservation. The second waits here, then sees
        // the first one's release row below. A plain SELECT would let both through.
        const locked = await tx<{ id: string }[]>`
          select id from journal_entries where id = ${reservationId} for update
        `
        if (locked.length === 0) throw new NotFoundError(`no reservation ${reservationId}`)

        const already = await tx<{ id: string }[]>`
          select id from journal_entries where reverses_entry_id = ${reservationId}
        `
        if (already.length > 0) {
          throw new AlreadyReleasedError(
            `reservation ${reservationId} was already released by entry ${already[0]!.id}`,
          )
        }

        const reservation = await readEntry(tx, reservationId)
        if (!reservation) throw new NotFoundError(`no reservation ${reservationId}`)

        const debit = reservation.postings.find((p) => p.direction === 'debit')
        const credit = reservation.postings.find((p) => p.direction === 'credit')
        if (!debit || !credit || reservation.postings.length !== 2) {
          throw new LedgerValidationError(
            `entry ${reservationId} is not a reservation: a reservation is exactly one debit and one credit`,
          )
        }

        const debitAccount = await findAccountById(tx, debit.accountId)
        const creditAccount = await findAccountById(tx, credit.accountId)
        if (debitAccount?.purpose !== 'available' || creditAccount?.purpose !== 'reserved') {
          throw new LedgerValidationError(
            `entry ${reservationId} is not a reservation: it does not move available to reserved`,
          )
        }

        // The mirror, built by contracts-money so the direction cannot be got backwards here.
        const pair = releasePostings({
          availableAccountId: debit.accountId,
          reservedAccountId: credit.accountId,
          assetCode: credit.assetCode,
          amount: BigInt(credit.amount),
        })

        const view = await writeEntry(
          tx,
          {
            kind: request.kind ?? 'transfer',
            originatingService: request.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            reversesEntryId: reservationId,
            description: request.description ?? `Release reservation ${reservationId}`,
            postings: pair.map((posting) => ({
              accountId: posting.accountId,
              direction: posting.direction,
              amount: posting.amount,
              assetCode: posting.assetCode,
              sequence: posting.sequence,
            })),
            ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
          },
          storedKey,
          deps.producer,
        )
        return { response: view, entryId: view.id }
      },
    })
  } catch (err) {
    throw mapDatabaseError(err)
  }
}
