/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied. The fix for a wrong migration is a new migration.
 *
 * ---------------------------------------------------------------------------------------------
 * **This file is where the ledger's invariants live, and that is deliberate.**
 *
 * 04-domain-model.md §2.2 lists five invariants and states that they are enforced "in the
 * database, not in application code". The reason is 00-current-state.md §3.3: `forge-pay`'s
 * `ledger` table is single-sided — one `delta` column, no account, no counter-account, no journal
 * grouping — so there is nothing for a balancing rule to attach to, and every rule that does exist
 * lives in whichever route happened to write the row. A rule in a route is a rule that the next
 * route forgets. A rule in a constraint is a rule that a bug, a migration, a psql session and a
 * future service all have to obey.
 *
 * The five, and where each one is:
 *
 *   1. Sigma debits = Sigma credits per entry per asset  ->  v6, `ledger_assert_entry_balanced`,
 *      a DEFERRED constraint trigger. The single most important line in the service.
 *   2. Postings are immutable                            ->  v6, `ledger_refuse_mutation` trigger
 *      plus REVOKE. Two mechanisms, because the trigger binds the table owner and the REVOKE
 *      binds everyone else.
 *   3. A correction is a new entry                       ->  v5, `reverses_entry_id`, and (2).
 *   4. `idempotency_key` is unique                       ->  v5, a unique constraint, claimed in
 *      the same transaction as the postings by `withIdempotency`.
 *   5. A liability may not go negative                   ->  v7, `ledger_assert_no_overdraft` on
 *      the balances projection.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },

  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },

  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },

  {
    version: 4,
    name: 'accounts',
    up: `
      -- The chart of accounts. Every unit of value in the platform sits in exactly one account.
      create table if not exists accounts (
        id                uuid        primary key default gen_random_uuid(),
        subject           text        not null,
        type              text        not null,
        asset_code        text        not null,
        purpose           text        not null,
        status            text        not null default 'open',
        overdraft_allowed boolean     not null default false,
        created_at        timestamptz not null default now(),

        constraint accounts_type_chk check (
          type in ('liability', 'asset', 'revenue', 'expense', 'equity', 'clearing')
        ),
        constraint accounts_purpose_chk check (
          purpose in ('available', 'reserved', 'escrow', 'treasury', 'fees', 'payout_due', 'suspense')
        ),
        constraint accounts_status_chk check (status in ('open', 'frozen', 'closed'))
      );

      -- INVARIANT: the account key is (subject, asset_code, purpose) and is unique.
      --
      -- 04-domain-model.md §2.1: "That single fact is what lets a user balance, a community
      -- treasury, a marketplace escrow and a platform revenue line all live in one double-entry
      -- system with no special cases." A second 'user:X available SHARD' account would split one
      -- user's balance across two rows, and every sum over it would be quietly wrong.
      create unique index if not exists accounts_key_uniq
        on accounts (subject, asset_code, purpose);

      create index if not exists accounts_subject_idx on accounts (subject);

      -- Reconciliation sums custody asset accounts and user liability accounts per asset; without
      -- this it is a sequential scan of the whole chart on every run.
      create index if not exists accounts_type_asset_idx on accounts (type, asset_code);
    `,
  },

  {
    version: 5,
    name: 'journal',
    up: `
      -- The financial source of truth. Append-only.
      create table if not exists journal_entries (
        id                  uuid        primary key,
        kind                text        not null,
        description         text,
        -- Present on EVERY entry, unlike today's optional 'ledger.source' which only the
        -- /internal/* routes populate — which is why per-product revenue is not derivable from
        -- the existing estate at all (00-current-state.md §3.3).
        originating_service text        not null,
        actor               text        not null,
        correlation_id      text        not null,
        idempotency_key     text        not null,
        -- INVARIANT 3: a correction is a new entry with this set. Never an edit.
        reverses_entry_id   uuid        references journal_entries (id),
        occurred_at         timestamptz not null,
        recorded_at         timestamptz not null default now(),
        metadata            jsonb       not null default '{}'::jsonb,

        -- INVARIANT 4: unique, and claimed in the same transaction as the postings.
        constraint journal_entries_idempotency_key_uniq unique (idempotency_key),

        -- The closed set from 04-domain-model.md §2.2. It is also the audit vocabulary, which is
        -- why it is a constraint rather than a convention: an entry kind nobody enumerated is an
        -- entry that no report, no alert and no audit query will ever count.
        constraint journal_entries_kind_chk check (kind in (
          'deposit_credited', 'withdrawal_requested', 'withdrawal_settled', 'withdrawal_refunded',
          'conversion', 'transfer', 'purchase', 'subscription_charge', 'fee_charged',
          'reward_granted', 'market_escrow', 'market_settled', 'royalty_paid', 'trading_fill',
          'performance_fee', 'creator_payout', 'treasury_spend', 'adjustment',
          'reconciliation_correction', 'reversal'
        )),

        -- An entry cannot reverse itself. Cheap to state, and it makes the reversal chain a DAG.
        constraint journal_entries_no_self_reversal_chk check (reverses_entry_id is distinct from id)
      );

      -- GET /entries is paginated by (recorded_at, id) and this is its access path. The existing
      -- wallet returns the entire unpaginated ledger on every call; this index is what makes not
      -- repeating that defect cheap.
      create index if not exists journal_entries_recorded_idx
        on journal_entries (recorded_at desc, id desc);

      create index if not exists journal_entries_kind_idx on journal_entries (kind, recorded_at desc);
      create index if not exists journal_entries_service_idx
        on journal_entries (originating_service, recorded_at desc);
      create index if not exists journal_entries_correlation_idx on journal_entries (correlation_id);

      -- Partial: reversals are a small fraction of the journal, and "what reversed this" must stay
      -- fast when the table is large.
      create index if not exists journal_entries_reverses_idx
        on journal_entries (reverses_entry_id)
        where reverses_entry_id is not null;

      create table if not exists postings (
        id         uuid          primary key default gen_random_uuid(),
        entry_id   uuid          not null references journal_entries (id),
        account_id uuid          not null references accounts (id),
        direction  text          not null,
        -- numeric(78,0), never a float. 78 digits holds any uint256 (max ~1.16e77), which is what
        -- an EVM token balance can be. The current estate stores these as TEXT, so the database
        -- cannot add them up and every sum happens in application code that may or may not use
        -- bigint.
        amount     numeric(78,0) not null,
        asset_code text          not null,
        sequence   integer       not null,

        constraint postings_direction_chk check (direction in ('debit', 'credit')),
        -- Amounts carry magnitude only; direction lives in 'direction'. The old 'ledger.delta'
        -- column encoded direction in the sign, and a posting set ported straight across from it
        -- is the failure this refuses.
        constraint postings_amount_positive_chk check (amount > 0),
        constraint postings_sequence_chk check (sequence >= 0),
        -- A posting has a stable identity within its entry, which is what lets a reversal be
        -- matched to the posting it mirrors.
        constraint postings_entry_sequence_uniq unique (entry_id, sequence)
      );

      create index if not exists postings_entry_idx on postings (entry_id);
      create index if not exists postings_account_idx on postings (account_id, asset_code);
      -- The replay path: the rebuild job reads every posting in entry order.
      create index if not exists postings_replay_idx on postings (entry_id, sequence);
    `,
  },

  {
    version: 6,
    name: 'journal_invariants',
    up: `
      -- =========================================================================================
      -- INVARIANT 1: Sigma debits = Sigma credits, per entry, per asset_code.
      --
      -- **This is the single most important thing in the service.**
      --
      -- It is a DEFERRED constraint trigger, which is the whole point. An entry is written as
      -- several INSERTs, so it is unbalanced between the first posting and the last; an immediate
      -- check would reject every legal entry. Deferring to COMMIT means the check runs once the
      -- transaction has finished writing and before it is durable — so a transaction that would
      -- commit an unbalanced entry fails at COMMIT and takes the whole entry with it. There is no
      -- window in which an unbalanced entry exists.
      --
      -- Per asset, not per entry, because an entry may legitimately touch two assets: a conversion
      -- debits a user's EMBER and credits their Shards in one atomic entry, and those two totals
      -- have no arithmetic relationship whatsoever. Summing across assets would make a nonsense
      -- entry balance and a correct one fail. This mirrors 'balanceEntry' in contracts-money,
      -- which is the same rule expressed for the application; neither is a substitute for the
      -- other, because contracts-money cannot bind a psql session and this cannot return a typed
      -- diagnosis to an API caller.
      -- =========================================================================================
      create or replace function ledger_assert_entry_balanced() returns trigger
        language plpgsql
      as $$
      declare
        target_entry uuid;
        offending    record;
        posting_count integer;
      begin
        -- Fired from both journal_entries (NEW.id) and postings (NEW.entry_id), so that an entry
        -- with no postings at all is caught as well as one whose postings do not balance.
        if tg_table_name = 'journal_entries' then
          target_entry := new.id;
        else
          target_entry := new.entry_id;
        end if;

        -- The entry may have been deleted later in the same transaction. Nothing to check.
        if not exists (select 1 from journal_entries where id = target_entry) then
          return null;
        end if;

        select count(*) into posting_count from postings where entry_id = target_entry;

        -- An entry that moves nothing is a bug in the caller, not an entry. It is also exactly
        -- what today's ledger writes as a breadcrumb: withdrawal request, refund and
        -- convert-to-ember all write 'delta: 0' rows (00-current-state.md §3.3).
        if posting_count = 0 then
          raise exception
            'entry % has no postings; an entry that moves nothing is not an entry', target_entry
            using errcode = 'check_violation';
        end if;

        -- Per asset: the debit side and the credit side must both exist and must be equal. A
        -- single-sided asset is reported distinctly because it is precisely what the table this
        -- replaces could express and nothing else.
        for offending in
          select
            p.asset_code,
            coalesce(sum(p.amount) filter (where p.direction = 'debit'), 0)  as debits,
            coalesce(sum(p.amount) filter (where p.direction = 'credit'), 0) as credits
          from postings p
          where p.entry_id = target_entry
          group by p.asset_code
          having coalesce(sum(p.amount) filter (where p.direction = 'debit'), 0)
               <> coalesce(sum(p.amount) filter (where p.direction = 'credit'), 0)
        loop
          raise exception
            'entry % does not balance for %: debits %, credits %, out by %',
            target_entry, offending.asset_code, offending.debits, offending.credits,
            offending.debits - offending.credits
            using errcode = 'check_violation';
        end loop;

        return null;
      end;
      $$;

      -- DEFERRABLE INITIALLY DEFERRED: the check happens at COMMIT, not at INSERT.
      drop trigger if exists journal_entries_balanced on journal_entries;
      create constraint trigger journal_entries_balanced
        after insert on journal_entries
        deferrable initially deferred
        for each row execute function ledger_assert_entry_balanced();

      -- The same check on postings, so that postings appended to an already-committed entry in a
      -- later transaction cannot unbalance it. Without this, the entry-level trigger only ever
      -- guards the transaction that created the entry.
      drop trigger if exists postings_balanced on postings;
      create constraint trigger postings_balanced
        after insert on postings
        deferrable initially deferred
        for each row execute function ledger_assert_entry_balanced();

      -- =========================================================================================
      -- INVARIANT 2: postings are immutable. No UPDATE, no DELETE.
      --
      -- Enforced twice, because the two mechanisms bind different people:
      --
      --   * The REVOKE below binds every role that is not the table's owner. It is the real
      --     access control and it is what the service's own database role runs under.
      --   * The trigger binds EVERYONE, including the owner and a superuser holding a psql
      --     session. Table privileges are not checked for the owner, so a REVOKE alone would
      --     leave the one account most likely to be used for a well-meant "quick fix" able to
      --     rewrite history silently.
      --
      -- A correction is a new entry with reverses_entry_id set (INVARIANT 3). That is not a
      -- stylistic preference: an audit trail that shows only the fix, and not the mistake, cannot
      -- be used to answer "what did we think was true on the 3rd".
      -- =========================================================================================
      create or replace function ledger_refuse_mutation() returns trigger
        language plpgsql
      as $$
      begin
        raise exception
          'postings are append-only: % is refused. Post a reversing entry instead (reverses_entry_id).',
          tg_op
          using errcode = 'restrict_violation';
      end;
      $$;

      drop trigger if exists postings_immutable on postings;
      create trigger postings_immutable
        before update or delete on postings
        for each row execute function ledger_refuse_mutation();

      -- Journal entries are append-only for the same reason. The one column a correction touches
      -- is on the NEW entry, never the old one.
      drop trigger if exists journal_entries_immutable on journal_entries;
      create trigger journal_entries_immutable
        before update or delete on journal_entries
        for each row execute function ledger_refuse_mutation();

      -- The privilege half. PUBLIC rather than a named role: the service's database user differs
      -- per environment, and granting the shape rather than the name means this migration does not
      -- have to know it. A deployment that runs the service as a non-owner gets defence in depth;
      -- one that runs it as the owner still has the triggers above.
      revoke update, delete, truncate on postings from public;
      revoke update, delete, truncate on journal_entries from public;
      grant select, insert on postings to public;
      grant select, insert on journal_entries to public;
    `,
  },

  {
    version: 7,
    name: 'balances',
    up: `
      -- A PROJECTION, not a source of truth (04-domain-model.md §2.3).
      --
      -- Maintained transactionally with each entry and rebuildable from the journal by replay.
      -- This is the difference from today, where 'wallets.shards' *is* the truth and nothing can
      -- check it: there is no journal to replay it from, so a wrong balance is wrong for ever.
      create table if not exists balances (
        account_id     uuid          not null references accounts (id),
        asset_code     text          not null,
        -- Held in the account's own NORMAL direction (contracts-money 'normalBalance'), so the
        -- number is "how much of this account there is" for both a liability and an asset, and
        -- nobody has to hold the sign convention in their head a second time. It is therefore
        -- signed: a negative value means the account has gone the wrong side of zero, which is
        -- exactly what the overdraft trigger below exists to refuse.
        amount         numeric(78,0) not null default 0,
        -- The last entry folded in. A rebuild compares against this to prove it replayed the same
        -- journal the projection was built from.
        as_of_entry_id uuid          references journal_entries (id),
        updated_at     timestamptz   not null default now(),

        primary key (account_id, asset_code)
      );

      -- =========================================================================================
      -- INVARIANT 5: a liability account may not go negative unless overdraft_allowed.
      --
      -- A user liability going negative means we have paid out value the user never had. That
      -- must fail loudly at the posting, not be discovered at the month end — so this is an
      -- IMMEDIATE trigger, not a deferred one: it fires on the balance write itself, inside the
      -- posting transaction, and names the account.
      --
      -- **AFTER INSERT OR UPDATE, not BEFORE, and that is not a stylistic choice.**
      --
      -- The projection is written with INSERT ... ON CONFLICT DO UPDATE, where the inserted
      -- amount column is the DELTA and the conflict path adds it to the stored balance. Postgres fires
      -- BEFORE INSERT row triggers *before* it detects the conflict, so a BEFORE trigger sees
      -- NEW.amount = the raw delta rather than the resulting balance. Every debit would then look
      -- like a negative balance: spending 100 of a 100 balance would be refused as an overdraft,
      -- and — far worse — the rule would appear to work, because a debit against an account with
      -- no balance row at all fails for the right reason by accident. An AFTER trigger fires once,
      -- on the row version actually written, which is the only version the invariant is about.
      --
      -- Concurrency: ON CONFLICT DO UPDATE takes a row lock on the balance row and re-reads the
      -- winning tuple, so two transactions debiting one account serialise on it and the second
      -- computes its delta against the first's committed amount. That is what makes "N parallel
      -- debits never drive a liability negative" true rather than merely likely.
      --
      -- Overdraft is permitted only for 'clearing' and 'suspense', which hold value in transit
      -- that is owed onwards — mirroring 'permitsOverdraft' and 'wouldOverdraw' in contracts-money.
      -- =========================================================================================
      create or replace function ledger_assert_no_overdraft() returns trigger
        language plpgsql
      as $$
      declare
        acct record;
      begin
        if new.amount >= 0 then
          return null;
        end if;

        select a.subject, a.type, a.purpose, a.overdraft_allowed
          into acct
          from accounts a
         where a.id = new.account_id;

        if acct is null then
          raise exception 'balance references unknown account %', new.account_id
            using errcode = 'foreign_key_violation';
        end if;

        -- A clearing account nets to zero over a settled period and may legitimately sit either
        -- side of zero within one. A non-zero clearing balance is reconciliation's business, not
        -- a constraint's.
        if acct.type = 'clearing' then
          return null;
        end if;
        if acct.overdraft_allowed or acct.purpose = 'suspense' then
          return null;
        end if;

        raise exception
          'account % (% %) would go to % — a % account may not go negative without overdraft_allowed',
          new.account_id, acct.subject, acct.purpose, new.amount, acct.type
          using errcode = 'check_violation';
      end;
      $$;

      drop trigger if exists balances_no_overdraft on balances;
      create trigger balances_no_overdraft
        after insert or update on balances
        for each row execute function ledger_assert_no_overdraft();
    `,
  },

  {
    version: 8,
    name: 'idempotency',
    up: `
      -- The claim table behind 'withIdempotency'.
      --
      -- Distinct from journal_entries.idempotency_key, and both are needed. The unique constraint
      -- on the entry is the invariant — one key, one entry, for ever. This table is what lets a
      -- duplicate request be REPLAYED rather than merely refused: it stores the response that was
      -- committed alongside the postings, so a retry is answered with the original answer instead
      -- of a 409 the caller cannot act on.
      --
      -- The shape is taken from repos/forge-pay/services/pay/src/store.ts:153, which is the best
      -- code in the existing estate. The behaviour inherited from it, in full:
      --   * the claim INSERT and the work share ONE transaction, so the stored response can never
      --     disagree with what actually committed;
      --   * a concurrent duplicate blocks on the conflicting insert until the original commits,
      --     then reads the stored response and replays it;
      --   * a reused key with a different body is a 409, not a silent replay of the wrong answer.
      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        -- sha256 of the canonicalised request body. A reused key with a changed payload is a
        -- caller bug that must be reported, not absorbed.
        request_hash text        not null,
        -- Null while the claiming transaction is still running. A duplicate that finds null is
        -- told to retry rather than handed an answer that does not exist yet.
        response     jsonb,
        entry_id     uuid        references journal_entries (id),
        created_at   timestamptz not null default now()
      );

      -- The reaper's access path.
      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },

  {
    version: 9,
    name: 'reconciliation',
    up: `
      create table if not exists reconciliation_runs (
        id                    uuid          primary key default gen_random_uuid(),
        chain                 text          not null,
        network               text          not null,
        asset_code            text          not null,
        started_at            timestamptz   not null default now(),
        finished_at           timestamptz,
        -- Sigma of the custody asset accounts, from the journal.
        ledger_custody_total  numeric(78,0) not null default 0,
        -- What the other side of the invariant says. Which side that is depends on
        -- observed_source, below.
        indexer_observed_total numeric(78,0) not null default 0,
        -- ledger_custody_total - indexer_observed_total. POSITIVE means the ledger claims to hold
        -- coin the other side does not show, and that is the dangerous direction: it is the shape
        -- of 'convertCoinToEmber' crediting custodial EMBER with no on-chain movement behind it.
        -- NEGATIVE is an uncredited deposit — still a bug, but one that owes the user rather than
        -- the reverse. The sign carries the meaning and must not be discarded.
        drift                 numeric(78,0) not null default 0,
        status                text          not null default 'failed',
        -- What the observed side actually was, stated rather than assumed.
        --
        --   'liability_sum' — Sigma of user liability accounts, computed from this ledger. This is
        --                     the internal half of the invariant and is the only half that can be
        --                     checked today, because the indexer service does not exist yet
        --                     (00-current-state.md §3.4). It catches a liability minted against no
        --                     custody position, which is the live 'convertCoinToEmber' defect.
        --   'indexer'       — Sigma of confirmed on-chain balances the indexer observes. Wired in
        --                     when AD-07 lands. The column names above are the domain model's and
        --                     are kept so that the row shape does not change when it does.
        --
        -- Recording which comparison was made is the point: a run whose observed side is unstated
        -- is a run whose green tick means nothing.
        observed_source       text          not null default 'liability_sum',
        notes                 text,

        constraint reconciliation_runs_status_chk check (
          status in ('clean', 'drift_within_tolerance', 'drift_exceeded', 'failed')
        ),
        constraint reconciliation_runs_source_chk check (
          observed_source in ('liability_sum', 'indexer')
        ),
        constraint reconciliation_runs_network_chk check (network in ('mainnet', 'testnet'))
      );

      create index if not exists reconciliation_runs_asset_idx
        on reconciliation_runs (asset_code, started_at desc);

      -- Exceeding tolerance freezes withdrawals for that asset and pages.
      --
      -- A table rather than a config flag, because the freeze must survive a restart and must be
      -- visible to every replica at once. POST /entries reads it inside the posting transaction
      -- for withdrawal-kind entries. Nothing like this exists today, and its absence is why a
      -- reconciliation failure has no mechanical consequence.
      create table if not exists asset_freezes (
        asset_code text        primary key,
        frozen_at  timestamptz not null default now(),
        reason     text        not null,
        -- Which run set it, so an operator can read the arithmetic that caused the freeze rather
        -- than take it on trust.
        run_id     uuid        references reconciliation_runs (id)
      );
    `,
  },

  {
    version: 10,
    name: 'balances_shadow',
    up: `
      -- Where the rebuild job replays the journal, so its answer can be compared with the live
      -- projection side by side in SQL rather than in a log line.
      --
      -- **Deliberately carries no overdraft trigger.** The shadow is diagnostic: if replaying the
      -- journal produces a negative liability, that is the single most important thing the job can
      -- tell an operator, and a constraint that aborted the rebuild would suppress exactly the
      -- finding the rebuild exists to surface. Constraints belong on the table that money is
      -- posted to, not on the table that audits it.
      --
      -- No foreign key to accounts for the same reason: a shadow row for an account that has since
      -- been removed is evidence, not an error to refuse.
      create table if not exists balances_shadow (
        account_id  uuid          not null,
        asset_code  text          not null,
        amount      numeric(78,0) not null default 0,
        rebuilt_at  timestamptz   not null default now(),
        primary key (account_id, asset_code)
      );
    `,
  },

  {
    version: 11,
    name: 'chain_backed_reconciliation',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- A CHECK THAT COULD NOT FAIL, GUARDING THE PROPERTY THE ECONOMY RESTS ON.
      --
      -- Migration 9 above permits observed_source in ('liability_sum', 'indexer') for EVERY asset,
      -- and its own comment says why: the indexer did not exist, so the internal half was the only
      -- half checkable. That is no longer true — micro-indexer has Bitcoin, Solana and EVM families
      -- with reorg handling — but the schema still accepted the vacuous answer, and every scheduled
      -- run in this service's life gave it. No production caller ever supplied an indexer total.
      --
      -- 'liability_sum' compares this ledger's custody accounts against this ledger's liability
      -- accounts. It is a real check of an INTERNAL identity and it catches convertCoinToEmber — a
      -- liability credited against no custody position. It CANNOT see a chain. A fabricated deposit
      -- moves both sides at once, so the books balance perfectly about coin that does not exist,
      -- and the run reports clean. Worse: 'clean' is the status that LIFTS a withdrawal freeze, so
      -- a vacuous run overrode a real one that had frozen the asset moments earlier.
      --
      -- 00-current-state.md:22 — "Custodial EMBER can be minted with no chain movement." The owner's
      -- decision is that the economics of the ecosystem must be valid FROM CHAIN. This migration is
      -- where that stops being a sentence in a document.
      --
      -- ── WHAT A SCHEMA CAN AND CANNOT DO HERE ─────────────────────────────────────────────────
      --
      -- It cannot verify the invariant. No constraint in this database can see a chain, and
      -- indexer_observed_total is an assertion by whoever called the job. A caller determined to
      -- fabricate one still can, and nothing below would notice. That is not a gap this migration
      -- can close — it is the honest boundary of a schema, and pretending otherwise would build a
      -- second check that cannot fail.
      --
      -- What it CAN do is refuse a run that never had evidence to begin with:
      --
      --   1. An on-chain asset may not be attested by this ledger's own books. observed_source
      --      'liability_sum' is illegal when the asset is chain-backed.
      --   2. A run with no observation must record 'unavailable', a NULL observed total, a NULL
      --      drift, and status 'failed'. It may not launder an absence into a zero.
      --
      -- Both are worth having precisely because they are mechanical. A handler-only guard is
      -- bypassed by a bug, a later migration, or an operator with a psql connection.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      -- Which assets are settled on a chain, and therefore may only be reconciled against one.
      --
      -- A TABLE rather than a literal list inside the CHECK, for two reasons that both bite:
      --
      --   * A CHECK cannot reference another table, and the alternative — inlining
      --     ('EMBER','BTC','ETH','SOL','XRP') into the constraint text — is a SECOND declaration of
      --     ON_CHAIN_ASSETS (contracts/packages/chain/src/index.ts:123) that would drift from the
      --     first in silence. contracts-money makes the same point about re-listing asset codes.
      --   * The migration text is CHECKSUMMED (@cloudsforge/db, checksumOf). Generating the list
      --     into this string from the imported constant would mean that adding a sixth chain asset
      --     silently changes an APPLIED migration's checksum, and every deployment would then refuse
      --     to start. A new chain asset is a new migration inserting a row, which is exactly right:
      --     it is a schema event, and it should leave a version behind.
      --
      -- 'reconcile.test.ts' asserts this table's contents equal ON_CHAIN_ASSETS, so the copy cannot
      -- go stale without a red test naming it.
      --
      -- SHARD is deliberately absent. contracts-chain gives it family 'evm' with the comment
      -- "never used on chain; present so the record is total", jobs.ts:chainNameFor records it as
      -- 'platform', and it has no chain to observe. Its internal identity is the only check there
      -- is for it, and that check is a real one — this migration must not break it.
      create table if not exists chain_assets (
        asset_code text primary key,
        -- Why this asset is here, so a later reader is not left guessing whether an entry was
        -- deliberate. Read by nothing; it exists to be read by a person.
        note       text not null
      );

      insert into chain_assets (asset_code, note) values
        ('EMBER', 'Hearth native. ON_CHAIN_ASSETS[0]. See the note on EMBER in reconcile.ts.'),
        ('BTC',   'Bitcoin. micro-indexer has a bitcoin family with reorg handling.'),
        ('ETH',   'EVM. micro-indexer has an evm family with reorg handling.'),
        ('SOL',   'Solana. micro-indexer has a solana family with reorg handling.'),
        ('XRP',   'XRP Ledger.')
      on conflict (asset_code) do nothing;

      -- ── 'unavailable': the third source, and the only honest one when nothing observed ────────
      alter table reconciliation_runs
        drop constraint if exists reconciliation_runs_source_chk;

      alter table reconciliation_runs
        add constraint reconciliation_runs_source_chk check (
          observed_source in ('liability_sum', 'indexer', 'unavailable')
        );

      -- **NULL, not 0.** A zero that means "we did not look" is this estate's signature defect in
      -- miniature: a value that reads as safe when it means nothing. numeric(78,0) NOT NULL DEFAULT 0
      -- forced exactly that lie, so both measured columns become nullable and NULL is reserved for
      -- "unknown". Existing rows are unaffected: they all carry an observed_source of 'liability_sum'
      -- or 'indexer' and non-null totals, so every constraint below validates against them as-is.
      alter table reconciliation_runs alter column indexer_observed_total drop not null;
      alter table reconciliation_runs alter column indexer_observed_total drop default;
      alter table reconciliation_runs alter column drift drop not null;
      alter table reconciliation_runs alter column drift drop default;

      -- Unknown is recorded as unknown, and ONLY then. Both directions, so neither
      -- "source says unavailable but a total is stated" nor "no total but the source claims one"
      -- can be written. Every operand is a NOT NULL column or an IS NULL predicate, so there is no
      -- three-valued-logic hole here — a CHECK that evaluates to NULL passes, and that is how this
      -- kind of constraint is usually silently vacuous.
      alter table reconciliation_runs
        add constraint reconciliation_runs_unobserved_chk check (
          (observed_source = 'unavailable') = (indexer_observed_total is null)
        );

      -- No drift without two numbers to subtract. Stating a drift of 0 beside an absent observation
      -- is the same laundering as above, one column over.
      alter table reconciliation_runs
        add constraint reconciliation_runs_drift_chk check (
          (indexer_observed_total is null) = (drift is null)
        );

      -- **ABSENCE OF EVIDENCE IS NOT EVIDENCE.** A run that observed nothing is 'failed', never
      -- 'clean' and never 'drift_within_tolerance'. This is the constraint that stops the whole
      -- defect coming back through a different door: freezesWithdrawals('failed') is true, so an
      -- asset nobody can observe is an asset nobody can withdraw, and — because only 'clean' lifts
      -- a freeze — such a run can never release one either.
      alter table reconciliation_runs
        add constraint reconciliation_runs_unobserved_failed_chk check (
          observed_source <> 'unavailable' or status = 'failed'
        );

      -- ── the rule a CHECK cannot express, because it must read another table ───────────────────
      --
      -- A trigger rather than a CHECK is forced by Postgres, not chosen: a CHECK may not reference
      -- chain_assets. It raises 23514 (check_violation) so a caller that already handles constraint
      -- violations treats it identically to one.
      --
      -- BEFORE INSERT OR UPDATE, not INSERT alone. UPDATE is a genuine bypass —
      -- 'update reconciliation_runs set observed_source = ''liability_sum''' would otherwise
      -- relabel a failed run as a checked one — and these rows are insert-only in the service, so
      -- covering UPDATE costs nothing real.
      create or replace function reconciliation_runs_require_chain_observation()
        returns trigger
        language plpgsql
      as $$
      begin
        if new.observed_source = 'liability_sum'
           and exists (select 1 from chain_assets c where c.asset_code = new.asset_code)
        then
          raise exception
            'reconciliation of on-chain asset % may not use observed_source=liability_sum: comparing this ledger against itself proves nothing about the chain',
            new.asset_code
            using errcode = '23514';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists reconciliation_runs_chain_observation_trg on reconciliation_runs;
      create trigger reconciliation_runs_chain_observation_trg
        before insert or update on reconciliation_runs
        for each row
        execute function reconciliation_runs_require_chain_observation();
    `,
  },

  {
    version: 12,
    name: 'unobserved_reason',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- A FREEZE THAT COULD NOT BE READ.
      --
      -- Migration 11 above made "nobody observed this asset" a first-class, recordable fact, and it
      -- was right to. What it did not record is WHY nobody observed it, and the estate found out
      -- what that costs the first time a real EMBER testnet was driven:
      --
      --   LEDGER_SERVICE_TOKEN held a 600-second token read once at boot. The reconciliation job
      --   runs every 900 seconds. From minute ten of every deployment the custody call 401'd, which
      --   this service maps to no observation, which lands here as observed_source='unavailable',
      --   indexer_observed_total NULL, drift NULL, status 'failed' — and freezes EMBER.
      --
      -- Every one of those columns was CORRECT. The run genuinely had no observation, and freezing
      -- was genuinely the right response. But the row it wrote is BYTE-IDENTICAL to the row written
      -- when Hearth is simply not followed, which is EMBER's honest, expected, argued-for state
      -- until that chain launches (see the note on LEDGER_RECONCILE_ASSETS in env.ts). So the check
      -- built to stop this ledger lying to itself was reporting a true fact for a false reason, in a
      -- shape nobody could distinguish from the true one. An operator reading 'unavailable' went to
      -- look at a chain that was fine.
      --
      -- The cause is fixed in code — ledger now holds a credential and mints its own tokens. This
      -- column exists because that fix does not generalise: an expired token is one of eight ways
      -- to fail to observe, and the next one will be silent again unless the row says which.
      --
      -- ── WHY THE SHAPE IS CONSTRAINED AND THE VOCABULARY IS NOT ───────────────────────────────
      --
      -- The CHECK below is a biconditional on PRESENCE — a run that observed nothing must say why,
      -- and a run that observed something may not pretend it did not. That is the same class of
      -- rule as migration 11's, and it is worth having for the same reason: a handler-only guard is
      -- bypassed by a bug, a later migration, or an operator with a psql connection.
      --
      -- The set of VALUES is deliberately not enumerated here, and that is a decision rather than
      -- an omission. Migration 11 argues at length that a list inlined into a CHECK is a second
      -- declaration that drifts from the first in silence, and that the migration text is
      -- CHECKSUMMED so regenerating it is not available either. The reasons live in one place —
      -- UnobservedReason in src/indexerclient.ts, a string union the compiler enforces at every
      -- site that produces one — and servicetoken.test.ts asserts this column only ever holds a
      -- member of it. Enumerating them here would also mean that adding a ninth failure mode
      -- makes the INSERT throw inside the reconciliation transaction until a migration ships,
      -- which would turn a new diagnosis into a dead-lettered job on the estate's solvency check.
      --
      -- The shape is still constrained: lower snake_case, 3..32 characters. That is enough to stop
      -- free text, an operator's note, or a raw error message — which could carry a URL, a token or
      -- a stack — being laundered into a column that is read by dashboards and logged in full.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      alter table reconciliation_runs add column if not exists unobserved_reason text;

      -- Rows written before this column existed. They are real unobserved runs and their reason is
      -- genuinely unknown, so it is recorded AS unknown rather than guessed at — the same principle
      -- as NULL-not-zero one column over. A live estate has these: the defect above produced them
      -- every fifteen minutes. Naming them 'unrecorded' rather than back-filling 'no_credential'
      -- keeps the constraint honest: this migration knows the rows had no reason stored, and it
      -- does not know what the reason was.
      update reconciliation_runs
         set unobserved_reason = 'unrecorded'
       where observed_source = 'unavailable'
         and unobserved_reason is null;

      alter table reconciliation_runs
        drop constraint if exists reconciliation_runs_reason_chk;
      alter table reconciliation_runs
        add constraint reconciliation_runs_reason_chk check (
          (observed_source = 'unavailable') = (unobserved_reason is not null)
        );

      alter table reconciliation_runs
        drop constraint if exists reconciliation_runs_reason_shape_chk;
      alter table reconciliation_runs
        add constraint reconciliation_runs_reason_shape_chk check (
          unobserved_reason is null or unobserved_reason ~ '^[a-z][a-z0-9_]{2,31}$'
        );

      -- The access path for "why has this asset been unobservable all week", which is the question
      -- asked once the freeze has been noticed and is the reason the column exists.
      create index if not exists reconciliation_runs_unobserved_idx
        on reconciliation_runs (asset_code, unobserved_reason, started_at desc)
        where unobserved_reason is not null;
    `,
  },

  {
    version: 13,
    name: 'retired_asset_guard',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- A RETIRED ASSET MAY NOT BE THE CONSIDERATION FOR A SALE.
      --
      -- SHARD was retired on 2026-08-04 — contracts/packages/chain/src/index.ts, RETIRED_ASSETS
      -- and IssuableAssetCode — and micro-billing closed its half the same day with
      -- 'prices_no_new_shard' (billing/src/migrations.ts, migration 11). Its argument is the
      -- argument for this one, quoted because it is the reason this lives here rather than only in
      -- a handler: "A comment does not stop an INSERT."
      --
      -- Billing stopped a retired PRICE existing. It could not stop a retired CHARGE, because a
      -- charge is not billing's row — it is a posting, and postings are here. micro-mint was never
      -- migrated: it priced a deploy in Shards, served the number as priceShards, and posted
      -- kind='purchase' with assetCode='SHARD' straight into this table. Nothing in this schema
      -- said no. The customer's screen said "Pay 2,500 Shards" and it was TRUE, which is why the
      -- surface could not be fixed by relabelling it.
      --
      -- ── WHAT THIS REFUSES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT ─────────────────────────
      --
      -- 121 SHARD accounts exist in the live ledger right now; 120 are user liabilities and 69 of
      -- those hold a balance, summing to 69,000 units, matched by one custody asset account of the
      -- same 69,000. That money is real and it belongs to people. **Retiring an asset must never
      -- strand it**, so the rule here is deliberately NOT "no posting may name a retired asset".
      -- Such a rule would refuse the withdrawal, the transfer, the conversion to EMBER, the
      -- reconciliation correction and the reversal — every route by which those 69,000 units can
      -- ever leave — and would convert a pricing defect into 69 frozen balances. A guard that
      -- traps a holder's own money is a worse defect than the one it fixes.
      --
      -- So the refusal is scoped to ACQUISITION kinds, and nothing else:
      --
      --   * 'purchase' and 'subscription_charge' — a product being SOLD for a wound-down unit.
      --     This is the exact ledger-side twin of billing's 'prices_no_new_shard': billing stops
      --     the price row, this stops the charge, and the second is needed because a service can
      --     post a charge without ever consulting a catalogue. micro-mint did.
      --   * 'deposit_credited' — value arriving from a chain. SHARD has no chain (jobs.ts,
      --     chainNameFor records it as the synthetic 'platform'), so a SHARD deposit could only
      --     ever be a fabrication, and refusing it costs nothing today and closes a route later.
      --
      -- Every other kind stays legal, and each one is a route money must keep taking:
      -- withdrawal_requested / withdrawal_settled / withdrawal_refunded (out), conversion (to
      -- EMBER — this is how the balances are meant to drain), transfer, adjustment,
      -- reconciliation_correction, reversal, and the engagement/market/trade kinds that live
      -- services still post in SHARD today (reward_granted, treasury_spend, trading_fill,
      -- performance_fee). Those last four are a REMAINING GAP, not an oversight: they can still
      -- put new SHARD into a holder's hands, and closing them means migrating micro-emberkin,
      -- micro-worlds, micro-market and micro-trade first. Tightening this trigger before those
      -- services move would break live paths in repositories this change does not own, which is
      -- the one thing a money-layer guard may not do.
      --
      -- ── WHY A TABLE AND A TRIGGER RATHER THAN A CHECK ────────────────────────────────────────
      --
      -- A CHECK cannot see across tables, and the rule is a JOIN: it is a property of the posting's
      -- asset AND of its entry's kind. So it is a trigger, the same mechanism INVARIANT 1 uses.
      --
      -- The asset list is a TABLE and not a literal inlined in the function body, for the two
      -- reasons migration 11 sets out about chain_assets and which apply unchanged here: an inline
      -- list is a second declaration of RETIRED_ASSETS free to drift from the first in silence,
      -- and generating it into this string would change an APPLIED migration's checksum the day a
      -- second asset is wound down, so every deployment would refuse to start. Retiring the next
      -- asset is a new migration inserting one row — a schema event that leaves a version behind,
      -- and one that tightens this rule across every service at once with no code change anywhere.
      -- 'entries.test.ts' asserts this table's contents equal RETIRED_ASSETS, so the copy cannot go
      -- stale without a red test naming it.
      --
      -- The KIND list is inline, and that asymmetry is deliberate. Which kinds constitute an
      -- acquisition is a property of this rule, decided once and argued above; it is not
      -- configuration, and an operator who could UPDATE it could re-open the exact hole this
      -- closes. It is in the checksummed migration text, where it cannot be edited after the fact.
      -- 'migrations.test.ts' asserts every kind named here is a member of ENTRY_KINDS, so a typo
      -- cannot produce a rule that silently matches nothing.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      create table if not exists retired_assets (
        asset_code text primary key,
        -- When the estate stopped issuing it, and why. Read by nothing; it exists to be read by a
        -- person asking why a posting was refused.
        retired_on date not null,
        note       text not null
      );

      insert into retired_assets (asset_code, retired_on, note) values
        ('SHARD',
         date '2026-08-04',
         'RETIRED_ASSETS[0] in contracts-chain. Balances stay readable and movable until drained; ' ||
         'see contracts 218300b and billing 2fe6d81.')
      on conflict (asset_code) do nothing;

      -- The same two mechanisms INVARIANT 2 uses on postings, for the same reason: the REVOKE binds
      -- every role that is not the owner, and an asset must not stop being retired because somebody
      -- with a psql session deleted a row to get a charge through.
      revoke update, delete, truncate on retired_assets from public;
      grant select on retired_assets to public;

      create or replace function ledger_refuse_retired_acquisition() returns trigger
        language plpgsql
      as $$
      declare
        entry_kind text;
      begin
        -- Cheapest test first: almost every posting in this ledger is in a live asset, and this
        -- trigger fires on every one of them.
        if not exists (select 1 from retired_assets where asset_code = new.asset_code) then
          return null;
        end if;

        -- postings.entry_id is a foreign key into journal_entries, so the row is always present by
        -- the time this fires. Read rather than assumed all the same: a null kind here would make
        -- the comparison below null, and a null is not a refusal.
        select kind into entry_kind from journal_entries where id = new.entry_id;
        if entry_kind is null then
          raise exception
            'posting % names entry % which has no kind', new.id, new.entry_id
            using errcode = 'check_violation';
        end if;

        if entry_kind in ('purchase', 'subscription_charge', 'deposit_credited') then
          raise exception
            '% is retired and may not be acquired: an entry of kind % may not be denominated in it. '
            'Existing holdings are unaffected — they may still be transferred, converted, adjusted, '
            'reversed and withdrawn.',
            new.asset_code, entry_kind
            using errcode = 'check_violation';
        end if;

        return null;
      end;
      $$;

      -- AFTER INSERT and NOT deferred, unlike the balancing trigger. Balancing has to be deferred
      -- because an entry is legitimately unbalanced between its first posting and its last; this
      -- rule is decidable from one row the moment it is written, and failing at the INSERT names
      -- the offending posting instead of failing the whole COMMIT with no line to point at.
      drop trigger if exists postings_no_retired_acquisition on postings;
      create trigger postings_no_retired_acquisition
        after insert on postings
        for each row execute function ledger_refuse_retired_acquisition();
    `,
  },

  {
    version: 14,
    name: 'litecoin_chain_asset',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- LITECOIN IS SETTLED ON A CHAIN, SO IT MAY NOT BE ATTESTED BY THIS LEDGER'S OWN BOOKS.
      --
      -- One row. It is a whole migration because migration 11 said it would have to be, and it was
      -- right: the text of an applied migration is CHECKSUMMED (@cloudsforge/db, checksumOf), so
      -- adding 'LTC' to the insert up there would change a checksum that every deployment has
      -- already recorded, and every deployment would then refuse to start. "A new chain asset is a
      -- new migration inserting a row, which is exactly right: it is a schema event, and it should
      -- leave a version behind." This is that version.
      --
      -- ── WHAT THIS ROW ACTUALLY TURNS ON ──────────────────────────────────────────────────────
      --
      -- Not documentation. 'chain_assets' is read by the INVARIANT 6 trigger (migration 11), and
      -- membership is what makes these two things true of LTC where they were not before:
      --
      --   1. observed_source = 'liability_sum' becomes ILLEGAL for it. Until this row existed, a
      --      Litecoin reconciliation could compare this ledger's custody accounts against this
      --      ledger's liability accounts and report 'clean' — the vacuous answer, about a chain it
      --      had never looked at. 'clean' is also the status that LIFTS a withdrawal freeze.
      --      'reconcile.test.ts' iterates ON_CHAIN_ASSETS and asserts the refusal for every member,
      --      so this was RED between the contracts release and this migration, which is the correct
      --      way round: the guard failing open is what a test must never let pass quietly.
      --   2. A run with no observation must record 'unavailable', a NULL total, a NULL drift and
      --      status 'failed' — it may not launder an absence into a zero.
      --
      -- ── WHY THIS IS SAFE TO APPLY TO THE LIVE ESTATE, CHECKED RATHER THAN ASSUMED ────────────
      --
      -- Membership here does not by itself cause a single reconciliation run. WHICH assets are
      -- swept is 'LEDGER_RECONCILE_ASSETS', which the estate sets explicitly to "SHARD,EMBER"
      -- (deploy/compose/docker-compose.estate.yml). BTC, ETH, SOL and XRP have sat in this table
      -- since migration 11 without ever being swept, and LTC joins them on exactly that footing.
      -- So this row cannot freeze anything today; it makes the freeze CORRECT on the day Litecoin
      -- is swept, which is the only day it could matter.
      --
      -- The insert is 'on conflict do nothing' for the same reason migration 11's is: a migration
      -- must be safe to re-run against a database that has somehow already got the row, and a
      -- duplicate-key error in a schema migration is an outage rather than a warning.
      --
      -- LTC's tolerance is deliberately NOT set here and belongs in 'LEDGER_ASSET_TOLERANCE'.
      -- Zero is the right bound for it and the reasoning is in 'env.ts' beside that variable: a
      -- UTXO chain's totals are exact integers on both sides, so any drift at all is a real one.
      -- Zero is also what an ABSENT entry already means — 'withinTolerance' fails closed — so the
      -- correct action is to state it rather than to change it.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      insert into chain_assets (asset_code, note) values
        ('LTC',
         'Litecoin. Bitcoin family in contracts-chain, so micro-indexer follows it with the ' ||
         'bitcoin worker and its reorg handling, unchanged. Confirmations are 12 and not ' ||
         'Bitcoin''s 6: ~2.5-minute blocks on a fraction of Bitcoin''s hashrate. Added by ' ||
         'migration 14 rather than by editing 11, whose text is checksummed.')
      on conflict (asset_code) do nothing;
    `,
  },

  {
    version: 15,
    name: 'dogecoin_and_classic_chain_assets',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- DOGE AND ETC JOIN THE ASSETS THIS LEDGER MAY NOT ATTEST TO BY ITSELF.
      --
      -- Two rows, one migration, appended rather than added to 11 or 14 for the reason 11 gave and
      -- 14 acted on: migration text is CHECKSUMMED (@cloudsforge/db, checksumOf), so editing an
      -- applied one is not a diff, it is every deployment refusing to start. A new chain asset is
      -- a new version, and this is the version for the two contracts-chain added on 2026-08-08.
      --
      -- Both go in one migration because they arrived in one contracts release and because the
      -- guard they feed is set-valued: 'reconcile.test.ts' asserts this table equals
      -- ON_CHAIN_ASSETS, so a migration that added one of the two would leave that assertion RED
      -- and the next reader unable to tell an unfinished change from a broken one.
      --
      -- ── WHAT THESE ROWS TURN ON, AND WHAT THEY DO NOT ────────────────────────────────────────
      --
      -- Membership makes 'observed_source' = 'liability_sum' ILLEGAL for these two codes (the
      -- INVARIANT 6 trigger, migration 11), and forces a run that observed nothing to record
      -- 'unavailable', a NULL total, a NULL drift and status 'failed'. That is the whole effect:
      -- it says HOW a DOGE or ETC reconciliation must be answered if one is ever asked for.
      --
      -- It does not ask for one. WHICH assets are swept is 'LEDGER_RECONCILE_ASSETS', which this
      -- service defaults to "SHARD,EMBER" and which the estate sets explicitly; BTC, ETH, SOL and
      -- XRP have sat in this table unswept since migration 11 and LTC since 14. DOGE and ETC join
      -- them on exactly that footing.
      --
      -- ── WHY NEITHER MAY BE ADDED TO THAT VARIABLE YET, WHICH IS THE POINT OF THIS PARAGRAPH ──
      --
      -- THE ESTATE HAS NO DOGECOIN NODE AND NO ETHEREUM CLASSIC NODE. contracts-chain records it
      -- of both: INDEXER_CHAINS follows neither, and no DOGE or ETC deposit has ever been credited
      -- at any depth. So a sweep named for either would reach 'observedTotalFor', get no answer,
      -- and record 'unavailable'/'failed' — which writes an 'asset_freezes' row.
      --
      -- That row is not undone by undoing the edit. Only an exactly-clean OBSERVED run lifts a
      -- freeze, and an unobservable asset cannot produce one, so removing the name from
      -- 'LEDGER_RECONCILE_ASSETS' afterwards leaves the freeze standing. Naming an asset there
      -- that this build cannot observe is therefore a one-way action, and the order it has to be
      -- done in is: indexer feed first, then the variable. This migration is deliberately only the
      -- first half — the schema is made ready and nothing is switched on.
      --
      -- 'on conflict do nothing' for migration 11's reason: a migration must survive being re-run
      -- against a database that already has the row, and a duplicate key here is an outage.
      --
      -- Tolerance is not a column and is not set here. It is 'LEDGER_ASSET_TOLERANCE', absent
      -- means zero, and 'withinTolerance' fails closed — so nothing needs doing for these two to
      -- be at zero. The day either is genuinely swept the bound is a decision rather than a
      -- default, and the two do not have the same one: DOGE is LTC's argument unchanged (an
      -- 8-decimal UTXO chain, integer outputs against integer postings, no rounding on either
      -- side, so any drift is real), while ETC is EMBER's question (18 decimals with fees in
      -- flight) and must be answered on ETC's own numbers rather than by copying EMBER's.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      insert into chain_assets (asset_code, note) values
        ('DOGE',
         'Dogecoin. Bitcoin family in contracts-chain, so micro-indexer would follow it with the ' ||
         'bitcoin worker — but it has no bech32 and no segwit, its addresses are base58 only, and ' ||
         'nothing in this estate follows it today. Confirmations are 30, derived from a measured ' ||
         '63.40s mean block time rather than copied from Litecoin''s 12. Not in ' ||
         'LEDGER_RECONCILE_ASSETS: there is no node to observe it, and a named unobservable asset ' ||
         'freezes permanently.'),
        ('ETC',
         'Ethereum Classic. EVM family, chain id 61 mainnet and 63 Mordor. Pre-London: no base ' ||
         'fee and no maxFeePerGas, so a settlement fee booked at plan time is exact for it. ' ||
         'Confirmations are 7,500 — ~28 hours — against a documented history of deep 51% ' ||
         'reorganisations. Not in LEDGER_RECONCILE_ASSETS, and for the same reason as DOGE: ' ||
         'nothing observes it, and a sweep of an unobservable asset freezes it for good.')
      on conflict (asset_code) do nothing;
    `,
  },

  {
    version: 16,
    name: 'item_issue_entry_kind',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- 'item_issue' JOINS THE CLOSED VOCABULARY, BECAUSE micro-tessera HAS BEEN POSTING IT SINCE
      -- BEFORE IT EXISTED.
      --
      -- 'tessera/src/ledgerclient.ts' issues one object to its author with kind 'item_issue'. That
      -- kind was never in ENTRY_KINDS and never in the constraint below, so every issuance this
      -- estate has ever attempted was refused — 'validateEntryRequest' answers an unknown kind with
      -- a 400 before a transaction is opened, so the refusal never even reached this CHECK. Zero
      -- TOKEN: accounts exist in the live ledger, which is the visible consequence: micro-tessera
      -- cannot activate a listing at all. micro-org#407 §3.
      --
      -- The alternative was to make micro-tessera spell an existing kind — the fix
      -- 'foresight.settlement_fee' got, which became 'fee_charged'. It is the wrong one here.
      -- Issuance is not a fee, a reward, a purchase or an adjustment: it is the event in which a
      -- new unit of a TOKEN: asset comes into existence, credited to its author against a clearing
      -- account. Filing it under 'adjustment' would make "how many of this object exist, and when
      -- did each appear" unanswerable from the journal, and the first paragraph of the constraint
      -- says why that matters: the vocabulary IS the audit.
      --
      -- ── WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO 1 ─────────────────────────────────────
      --
      -- Migration text is CHECKSUMMED (@cloudsforge/db, checksumOf). Adding the word to migration
      -- 1's list would change a checksum every environment has already recorded, and every one of
      -- them would refuse to start — the same reasoning migrations 14 and 15 give for chain assets.
      -- So the constraint is dropped and re-added here, in full.
      --
      -- ── WHY DROP-AND-ADD IS SAFE ON THE LIVE ESTATE, AND WHAT IT COSTS ───────────────────────
      --
      -- 'drop constraint ... if exists' then 'add constraint ... not valid', followed by
      -- 'validate constraint'. The two-step is deliberate: 'add constraint' alone takes an ACCESS
      -- EXCLUSIVE lock and scans every row in 'journal_entries' while holding it, which on a table
      -- that only ever grows is a write outage of unbounded length. 'not valid' takes the lock for
      -- the catalogue write alone and applies to every row inserted from that instant; 'validate
      -- constraint' then reads the existing rows under a SHARE UPDATE EXCLUSIVE lock, which does
      -- not block inserts. Postings are immutable and append-only (INVARIANT 2), so there is no
      -- window in which an unchecked row can slip in.
      --
      -- The validation cannot fail. The new list is a strict superset of the old one, so every row
      -- that satisfied the old constraint satisfies this one. It is still run rather than assumed:
      -- a constraint left NOT VALID is honoured for new rows but ignored by the planner, and a
      -- future reader would have no way to tell "deliberately deferred" from "forgotten".
      --
      -- ── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────────────────────────
      --
      -- It does not add 'item_issue' to migration 13's acquisition set. That set is what may not be
      -- denominated in a RETIRED asset, and it names the ways a USER acquires one — purchase,
      -- subscription_charge, deposit_credited. An issuance is the system bringing an object into
      -- existence against a clearing account; a TOKEN: asset code cannot be retired because
      -- RETIRED_ASSETS is a contracts-chain list of chain assets, so widening that guard here would
      -- add a rule that can never match.
      --
      -- It also does not backfill anything. There is nothing to backfill: no 'item_issue' row was
      -- ever written, because none was ever accepted.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      alter table journal_entries
        drop constraint if exists journal_entries_kind_chk;

      alter table journal_entries
        add constraint journal_entries_kind_chk check (kind in (
          'deposit_credited', 'withdrawal_requested', 'withdrawal_settled', 'withdrawal_refunded',
          'conversion', 'transfer', 'purchase', 'subscription_charge', 'fee_charged',
          'reward_granted', 'item_issue', 'market_escrow', 'market_settled', 'royalty_paid',
          'trading_fill', 'performance_fee', 'creator_payout', 'treasury_spend', 'adjustment',
          'reconciliation_correction', 'reversal'
        )) not valid;

      alter table journal_entries
        validate constraint journal_entries_kind_chk;
    `,
  },

  {
    version: 17,
    name: 'liquidity_seed_entry_kind',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- 'liquidity_seed' JOINS THE CLOSED VOCABULARY, BECAUSE FORGE EXCHANGE PUTS MINED EMBER INTO
      -- AN AMM POOL AND NO EXISTING KIND DESCRIBES THAT.
      --
      -- docs/ecosystem/39 §6 phase F seeds a Hearth V2 pair on EMBER mainnet out of what the two
      -- estate miners have produced, and the gate on that phase is written as "the estate's own
      -- solvency reporting books the seeded liquidity". Booking it needs a word, and none of the
      -- twenty-one already here is the right one:
      --
      --   'treasury_spend'  — nothing was spent. The position is recoverable in full by burning
      --                       the LP tokens the estate holds, and the estate holds all of them.
      --   'transfer'        — a transfer leaves two subjects each holding what they hold. Here the
      --                       counter-asset is minted into the same act, and from the moment the
      --                       pair is live the reserves move on every stranger's swap.
      --   'conversion'      — nothing was exchanged at a rate. The rate is what the pool is FOR.
      --   'adjustment'      — the escape hatch, and using it would make "how much of the estate's
      --                       own EMBER is committed to a pool, and since when" unanswerable from
      --                       the journal. The vocabulary IS the audit (migration 1, first
      --                       paragraph of the constraint).
      --
      -- ── WHAT IT POSTS, AND THE ACCOUNT IT DELIBERATELY DOES NOT TOUCH ────────────────────────
      --
      --   DEBIT   platform / <asset> / reserved   (type asset)   the position, owned but illiquid
      --   CREDIT  platform / <asset> / treasury   (type equity)  mining income, now recognised
      --
      -- The second side is equity because the EMBER being seeded was mined by the estate and was
      -- never anyone's claim: it belongs to no user, no organisation and no custody arrangement.
      --
      -- The account this must NEVER touch is anything with subject 'custody'. reconcile.ts sums
      -- exactly (type = 'asset' AND subject = 'custody') for an asset and compares it to what the
      -- indexer observes across the addresses labelled 'deposit:' and 'treasury:'. EMBER's drift
      -- tolerance is zero. A pair's reserve changes whenever an outsider trades against it, so
      -- booking a pool as custody — or adding the pair address to the watched set — would put a
      -- number nobody controls on one side of an equality with zero slack, and the first swap by a
      -- stranger would freeze every EMBER withdrawal in the estate. docs/ecosystem/35 G1 names
      -- that failure: watching an address without booking it is "an invented insolvency", and this
      -- is its mirror image. Neither side of this entry carries subject 'custody', so the
      -- reconciliation total is arithmetically untouched by seeding a pool.
      --
      -- ── WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO 16 ────────────────────────────────────
      --
      -- Migration text is CHECKSUMMED (@cloudsforge/db, checksumOf). Editing 16 would change a
      -- checksum every environment has already recorded and none of them would start. Same reason
      -- 16 gave for not editing 1, and 14 and 15 gave for not editing 11.
      --
      -- The drop/add-not-valid/validate shape is 16's, for 16's reasons: 'add constraint' alone
      -- takes ACCESS EXCLUSIVE and scans a table that only grows, which is a write outage of
      -- unbounded length; 'not valid' takes the lock for the catalogue write alone and binds every
      -- row inserted from that instant; 'validate' then reads the existing rows under SHARE UPDATE
      -- EXCLUSIVE, which does not block inserts. The new list is a strict superset of the old one,
      -- so validation cannot fail — it is still run, because a constraint left NOT VALID is
      -- ignored by the planner and indistinguishable from a forgotten step.
      --
      -- Nothing is backfilled. No 'liquidity_seed' row exists, because none was ever accepted.
      -- ══════════════════════════════════════════════════════════════════════════════════════════

      alter table journal_entries
        drop constraint if exists journal_entries_kind_chk;

      alter table journal_entries
        add constraint journal_entries_kind_chk check (kind in (
          'deposit_credited', 'withdrawal_requested', 'withdrawal_settled', 'withdrawal_refunded',
          'conversion', 'transfer', 'purchase', 'subscription_charge', 'fee_charged',
          'reward_granted', 'item_issue', 'liquidity_seed', 'market_escrow', 'market_settled',
          'royalty_paid', 'trading_fill', 'performance_fee', 'creator_payout', 'treasury_spend',
          'adjustment', 'reconciliation_correction', 'reversal'
        )) not valid;

      alter table journal_entries
        validate constraint journal_entries_kind_chk;
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. Zero for a new service.
 *
 * The ledger is new — there is nothing to baseline, because the thing it replaces
 * (00-current-state.md §3.3) is a different table in a different database with a different shape.
 * Migrating value out of `forge-pay`'s single-sided `ledger` is a data migration with its own
 * opening-balance entries, not a schema baseline.
 */
export const BASELINE_VERSION = 0
