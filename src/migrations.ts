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
