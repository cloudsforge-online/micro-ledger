/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * The journal. Of the six services micro-org#534 named, this is the one where the estate's rule —
 * **when a person asks to be forgotten, everything is anonymised** (`deploy/erasure/register.psv`)
 * — is not a preference but the only thing available.
 *
 * ## Why deletion is not on the table here, at all
 *
 * A posting belongs to an account and an account belongs to a subject. Delete the account and every
 * posting that referenced it is a debit or a credit with no counterpart: the trial balance stops
 * balancing, `balances` and `balances_shadow` disagree with a journal that no longer explains them,
 * and `reconciliation_runs` compares two numbers neither of which can be traced. That is not a
 * degraded audit trail, it is a forged one — the estate's own architecture makes this service the
 * record of what happened, and a record you can delete a party out of is not a record.
 *
 * So: Art. 17(3)(b), a legal obligation to keep accounting records, and the row stays.
 *
 * ## What makes this a genuinely small change
 *
 * `accounts.subject` is the ONLY column in this schema that names a person. `postings`, `balances`,
 * `balances_shadow`, `journal_entries`, `asset_freezes`, `idempotency_keys` and
 * `reconciliation_runs` all reach a subject through `account_id` and never store one — checked
 * column by column, and `erasure.test.ts` re-checks it from `information_schema` on every run so a
 * future migration that denormalises the subject turns that test red rather than leaking quietly.
 *
 * One UPDATE therefore anonymises the whole service, and every balance, posting and entry keeps
 * working with no change at all: they were never joined on the subject.
 *
 * ## The decisions
 *
 * | table                  | action    | reasoning, and the lawful basis |
 * | ---------------------- | --------- | -------------------------------- |
 * | `accounts`             | ANONYMISE | `subject` to `erased:<uuid>`. `type`, `asset_code`, `purpose`, `status` and `overdraft_allowed` are properties of an ACCOUNT, not of a person, and every one of them is load-bearing for the trial balance. Basis: Art. 17(3)(b). |
 * | `postings`, `balances`, `balances_shadow`, `journal_entries` | — | No subject column. They reach one through `account_id`, which is exactly why anonymising the account is sufficient AND complete. |
 * | `asset_freezes`, `reconciliation_runs`, `idempotency_keys` | — | No subject. A freeze names an asset, a run names a window, a key names an operation. |
 * | `outbox`               | REDACT    | The outbound journal. Published rows are an audit trail and unpublished ones must still be delivered, so the subject is swept out of `key`, `actor` and `payload` in place rather than the rows being dropped — dropping an unpublished row loses an event. |
 * | `inbox`, `outbox_deliveries`, `event_subscriptions` | — | `(topic, event_id)`, `(event_id, subscription_id)` and a URL. No subject in any of them. |
 *
 * ## The placeholder
 *
 * ONE random uuid per erasure, from `randomUUID()`, never derived from the subject it replaces. A
 * hash of a subject is not an anonymisation: the candidate space is whatever list of users an
 * attacker already has, and checking it is one hash each. Nothing anywhere stores the mapping.
 *
 * Reused across every account this erasure touches, deliberately: a person with an EMBER available
 * account, an EMBER reserved account and a BTC available account keeps them linked to one another,
 * which is unavoidable the moment anything is retained — their timestamps and their postings link
 * them regardless — and is required, because `accounts (subject, asset_code, purpose)` is the
 * lookup every balance read uses and three fresh placeholders would turn one party into three.
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

/** The estate-wide erasure signal. Registered in `contracts/packages/events`. */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

/** Counts only. Every field is a number: this record is logged, and personal data is not. */
export interface ErasureOutcome {
  readonly accounts: number
  readonly outbox: number
}

/**
 * Erase one subject, inside the caller's transaction.
 *
 * `subject` and not a bare uuid: `accounts.subject` holds the ledger spelling `user:<uuid>`, and a
 * bare uuid would match nothing and answer a cheerful zero — the failure `nda` recorded, where a
 * deletion erased nobody and reported success.
 *
 * Idempotent beyond the inbox: the UPDATE selects on the REAL subject, which no longer appears once
 * the first pass has committed, so a second pass is a no-op. That is what makes replaying an old
 * event id safe, and replaying old event ids is how a plane that was never erased gets repaired
 * (micro-org#474).
 */
export async function eraseSubject(tx: Tx, subject: string): Promise<ErasureOutcome> {
  const placeholder = randomUUID()
  const erased = `erased:${placeholder}`
  const bare = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
  const anywhere = `%${bare}%`

  // ONE column, and it is the whole of what this service knows about a person. Every posting,
  // balance and journal entry keeps its account_id and needs no change: none of them was ever
  // joined on the subject.
  const accounts = await tx`
    update accounts set subject = ${erased} where subject = ${subject} returning 1
  `

  // Swept, not dropped: an unpublished row still has to be delivered, and dropping it would lose
  // the event rather than anonymise it. The uuid is matched rather than the `user:` spelling,
  // because a payload may carry either.
  const outbox = await tx`
    update outbox
       set key     = replace(key, ${bare}, ${placeholder}),
           actor   = case when actor is null then null else replace(actor, ${bare}, ${placeholder}) end,
           payload = replace(payload::text, ${bare}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning 1
  `

  return { accounts: accounts.length, outbox: outbox.length }
}
