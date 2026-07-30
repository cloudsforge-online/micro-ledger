/**
 * The balances projection, and the replay that proves it.
 *
 * 04-domain-model.md §2.3: `balance` is a **projection, not a source of truth**. It is maintained
 * transactionally with each entry (see `applyToBalances` in `entries.ts`) and is **rebuildable
 * from the journal by replay**. A nightly job rebuilds a shadow copy and compares; a mismatch is a
 * P0 alert.
 *
 * **This is the difference from today.** In `forge-pay`, `wallets.shards` *is* the truth: it is a
 * running column, nothing derives it, and there is no journal to replay it from — so a balance
 * that is wrong is wrong for ever and nothing in the estate can even detect it. Here the journal
 * is the truth, the projection is a cache of it, and the two are checked against each other on a
 * schedule. A projection nobody verifies is just a second truth.
 *
 * The replay below applies `applyPosting` from `@cloudsforge/contracts-money` — the same function
 * the write path's sign convention comes from. It deliberately does **not** re-express the sign
 * convention as a SQL `case` expression: a rebuild that used a second, independently written copy
 * of the rule would agree with the projection exactly when both copies were wrong in the same way,
 * which is the one circumstance in which the check needs to fail.
 */

import { type AccountType, type Posting, applyPosting } from '@cloudsforge/contracts-money'
import type { Db } from './outbox.ts'

/** How many postings one replay batch reads. Bounds memory on a journal of any length. */
const REPLAY_BATCH = 5_000

/** `${accountId}|${assetCode}` — the projection's primary key, as one string. */
type BalanceKey = string

export interface ReplayResult {
  /** Balance per `(account, asset)`, in the account's own normal direction. */
  readonly balances: ReadonlyMap<BalanceKey, bigint>
  readonly postingsRead: number
  /** The last entry folded in, so a caller can prove which journal prefix produced this. */
  readonly lastEntryId: string | null
}

interface ReplayRow {
  readonly entry_id: string
  readonly account_id: string
  readonly account_type: string
  readonly direction: string
  readonly amount: string
  readonly asset_code: string
  readonly sequence: number
}

/**
 * Rebuild every balance from the journal.
 *
 * Read in `(entry_id, sequence)` order with a keyset cursor rather than OFFSET: the journal is
 * append-only and only ever grows, so an OFFSET replay would be quadratic in the size of the
 * table. `entry_id` is UUIDv7, so that order is also chronological.
 *
 * Memory is bounded by the number of `(account, asset)` pairs — the chart of accounts — not by the
 * length of the journal, which is what makes a full replay of years of history feasible in one
 * process.
 */
export async function replayBalances(sql: Db): Promise<ReplayResult> {
  const balances = new Map<BalanceKey, bigint>()
  let cursorEntry: string | null = null
  let cursorSequence = -1
  let postingsRead = 0
  let lastEntryId: string | null = null

  for (;;) {
    const rows: ReplayRow[] = await sql<ReplayRow[]>`
      select p.entry_id, p.account_id, a.type as account_type, p.direction,
             p.amount::text as amount, p.asset_code, p.sequence
        from postings p
        join accounts a on a.id = p.account_id
       where ${cursorEntry}::uuid is null
          or (p.entry_id, p.sequence) > (${cursorEntry}::uuid, ${cursorSequence}::integer)
       order by p.entry_id, p.sequence
       limit ${REPLAY_BATCH}
    `
    if (rows.length === 0) break

    for (const row of rows) {
      const posting: Posting = {
        accountId: row.account_id,
        direction: row.direction === 'debit' ? 'debit' : 'credit',
        amount: BigInt(row.amount),
        assetCode: row.asset_code as Posting['assetCode'],
        sequence: row.sequence,
      }
      const key: BalanceKey = `${row.account_id}|${row.asset_code}`
      // The projection, in one function — contracts-money's own words for `applyPostings`.
      balances.set(key, applyPosting(balances.get(key) ?? 0n, posting, row.account_type as AccountType))
      lastEntryId = row.entry_id
    }

    postingsRead += rows.length
    const last = rows[rows.length - 1]!
    cursorEntry = last.entry_id
    cursorSequence = last.sequence

    if (rows.length < REPLAY_BATCH) break
  }

  return { balances, postingsRead, lastEntryId }
}

export interface BalanceMismatch {
  readonly accountId: string
  readonly assetCode: string
  /** What the live projection says. */
  readonly projected: string
  /** What replaying the journal says. The journal is the truth; the projection is not. */
  readonly replayed: string
  readonly difference: string
}

export interface RebuildReport {
  readonly checked: number
  readonly postingsRead: number
  readonly mismatches: readonly BalanceMismatch[]
  /** **A mismatch is a P0.** The projection and the journal disagree about how much money exists. */
  readonly clean: boolean
  readonly startedAt: string
  readonly finishedAt: string
}

/**
 * Replay the journal into `balances_shadow`, then compare it with `balances`.
 *
 * The shadow is a real table rather than an in-memory diff so that a mismatch leaves evidence: an
 * operator woken at 3am needs to query the two side by side, not re-run the job and hope it
 * reproduces. It is rewritten on every run inside one transaction, so a reader never sees a
 * half-built shadow and mistakes it for a disagreement.
 *
 * Comparison is a FULL OUTER JOIN, not a loop over one side. A row present in one table and absent
 * from the other is exactly the interesting case — a projection row for postings that do not
 * exist, or postings whose projection row was never written — and iterating either side alone
 * would miss half of them.
 */
export async function rebuildBalances(sql: Db): Promise<RebuildReport> {
  const startedAt = new Date().toISOString()
  const { balances, postingsRead } = await replayBalances(sql)

  const rows = [...balances.entries()].map(([key, amount]) => {
    const separator = key.lastIndexOf('|')
    return {
      accountId: key.slice(0, separator),
      assetCode: key.slice(separator + 1),
      amount: amount.toString(),
    }
  })

  const mismatches = await sql.begin(async (tx) => {
    await tx`delete from balances_shadow`
    for (const row of rows) {
      await tx`
        insert into balances_shadow (account_id, asset_code, amount)
        values (${row.accountId}, ${row.assetCode}, ${row.amount}::numeric(78,0))
      `
    }

    const found = await tx<
      {
        account_id: string
        asset_code: string
        projected: string
        replayed: string
        difference: string
      }[]
    >`
      select coalesce(b.account_id, s.account_id)::text as account_id,
             coalesce(b.asset_code, s.asset_code)       as asset_code,
             coalesce(b.amount, 0)::text                as projected,
             coalesce(s.amount, 0)::text                as replayed,
             (coalesce(b.amount, 0) - coalesce(s.amount, 0))::text as difference
        from balances b
        full outer join balances_shadow s
          on s.account_id = b.account_id and s.asset_code = b.asset_code
       where coalesce(b.amount, 0) <> coalesce(s.amount, 0)
       order by 1, 2
    `
    return { value: found }
  })

  return {
    checked: rows.length,
    postingsRead,
    mismatches: mismatches.value.map((row) => ({
      accountId: row.account_id,
      assetCode: row.asset_code,
      projected: row.projected,
      replayed: row.replayed,
      difference: row.difference,
    })),
    clean: mismatches.value.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}
