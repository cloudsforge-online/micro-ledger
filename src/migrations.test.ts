import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { ENTRY_KINDS } from '@cloudsforge/contracts-money'
import { RETIRED_ASSETS } from '@cloudsforge/contracts-chain'
import { ACQUISITION_KINDS } from './entries.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'

const sql = MIGRATIONS.map((m) => m.up).join('\n')

/**
 * The DDL with `--` comments removed.
 *
 * Assertions that a migration does *not* contain something must run against the statements, not
 * the prose: these migrations explain their reasoning at length, and a comment saying why a table
 * carries no trigger contains the word "trigger".
 */
const statementsOf = (text: string): string => text.replace(/--[^\n]*/g, '')

test('versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length, 'a duplicate version makes the run refuse')
})

test('SCHEMA_VERSION is the highest migration, so a new one raises the boot assertion', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines nothing', () => {
  assert.equal(BASELINE_VERSION, 0, 'a non-zero baseline records migrations as applied without running them')
})

test('no migration interpolates anything into its SQL', () => {
  // The `up` strings are template literals. A stray `${...}` would substitute silently and ship
  // DDL nobody wrote — and because the checksum is taken over the substituted text, two
  // environments could disagree about what a migration even says. (A stray backtick is a compile
  // error and so guards itself; this is the half that would not.)
  for (const m of MIGRATIONS) {
    assert.doesNotMatch(m.up, /\$\{/, `${m.name} interpolates into its SQL`)
  }
})

test('checksums are stable, which is what makes an edited migration refuse to run', () => {
  for (const m of MIGRATIONS) {
    assert.equal(checksumOf(m), checksumOf({ ...m, up: `\n  ${m.up}  \n` }), `${m.name} is whitespace-sensitive`)
  }
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CHECKSUM LOCK — editing an applied migration is caught HERE, not by a failed deployment.
 *
 * Two files in this repository tell a reader not to edit a migration that has shipped.
 * `reconcile.test.ts` says it in the message on the `chain_assets` assertion: "If this fails, do
 * NOT edit migration 11 — `@cloudsforge/db` refuses a changed migration by checksum, and rightly.
 * Add a new one." Migration 11's own text says the same at length.
 *
 * **Both were prose, and prose does not fail a build.** Adding `('LTC', …)` to migration 11's
 * insert — the obvious, wrong, one-line way to do what migration 14 does — passed every test in
 * this repository. It would have been caught by `@cloudsforge/db` refusing to start, in the
 * migrator container, on the deploy, against the live estate's schema, taking every ledger replica
 * that waits on it down with it. That is the most expensive possible place to learn it.
 *
 * So the checksums of migrations that have been applied are written down. A change to the TEXT of
 * any of them fails here, in a second, on a branch.
 *
 * ── HOW TO ADD A MIGRATION (this test does not obstruct that) ─────────────────────────────────
 *
 * Append it to `MIGRATIONS` and add its version and checksum below. That is the whole procedure,
 * and it is deliberately a two-line diff rather than an automatic one: a mechanism that re-recorded
 * these itself would agree with whatever it was given and check nothing.
 *
 * ── HOW TO CHANGE AN APPLIED ONE ─────────────────────────────────────────────────────────────
 *
 * You cannot. That is the point. Write a new migration that alters what the old one created.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const APPLIED_CHECKSUMS: Readonly<Record<number, string>> = Object.freeze({
  1: 'eb9bd289',
  2: '2479dd84',
  3: '8b24c44e',
  4: '693798d7',
  5: '5800efa4',
  6: '278ec770',
  7: '02833933',
  8: 'c67de1c5',
  9: '99880cfb',
  10: 'c165a0ef',
  11: '2b3e9b64',
  12: '37b85469',
  13: 'f17ce678',
  14: 'e2aee319',
})

test('AN APPLIED MIGRATION IS IMMUTABLE, and this is where editing one is caught', () => {
  for (const m of MIGRATIONS) {
    const expected = APPLIED_CHECKSUMS[m.version]
    assert.ok(
      expected,
      `migration ${m.version} (${m.name}) has no recorded checksum. If it is NEW, add ` +
        `${m.version}: '${checksumOf(m)}' to APPLIED_CHECKSUMS above.`,
    )
    assert.equal(
      checksumOf(m),
      expected,
      `migration ${m.version} (${m.name}) HAS BEEN EDITED. Its text has already been applied and ` +
        'recorded in every environment, so @cloudsforge/db will refuse to start against it. Revert ' +
        'the edit and write a new migration that alters what this one created.',
    )
  }
  // Both directions: a deleted migration is as bad as an edited one, and leaves a gap in the
  // version sequence that a fresh database would apply differently from an existing one.
  assert.equal(
    MIGRATIONS.length,
    Object.keys(APPLIED_CHECKSUMS).length,
    'a migration was removed, or one was added without recording its checksum',
  )
})

test('migration 11 in particular still says exactly what it said, LTC having gone in via 14', () => {
  // Named on its own because it is the one this release was most tempted to edit: `chain_assets` is
  // seeded there, `reconcile.test.ts` asserts that table equals ON_CHAIN_ASSETS, and adding a row
  // to the existing insert is a one-character-per-asset change that looks completely reasonable.
  const eleven = MIGRATIONS.find((m) => m.version === 11)
  const fourteen = MIGRATIONS.find((m) => m.version === 14)
  assert.ok(eleven && fourteen)
  assert.doesNotMatch(eleven.up, /'LTC'/, 'LTC was added to migration 11 instead of to a new one')
  assert.match(fourteen.up, /insert into chain_assets[\s\S]*?'LTC'/)
  assert.match(fourteen.up, /on conflict \(asset_code\) do nothing/)
})

test('every table the service reads or writes is created', () => {
  for (const table of [
    'jobs',
    'outbox',
    'event_subscriptions',
    'outbox_deliveries',
    'inbox',
    'accounts',
    'journal_entries',
    'postings',
    'balances',
    'balances_shadow',
    'idempotency_keys',
    'reconciliation_runs',
    'asset_freezes',
    'chain_assets',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}\\b`), `${table} is missing`)
  }
})

/* ------------------------------------------------------------------ the five invariants */

test('INVARIANT 1: the balancing trigger is DEFERRED, on both journal_entries and postings', () => {
  // The word that makes the whole thing work. An immediate constraint would reject every legal
  // entry, because an entry is unbalanced between its first posting and its last.
  assert.match(sql, /create constraint trigger journal_entries_balanced[\s\S]*?deferrable initially deferred/)
  assert.match(sql, /create constraint trigger postings_balanced[\s\S]*?deferrable initially deferred/)
  // Grouped per asset: a conversion touches two assets whose totals have no arithmetic
  // relationship, so summing across them would make a nonsense entry balance.
  assert.match(sql, /group by p\.asset_code/)
})

test('INVARIANT 2: postings are immutable, by trigger AND by revoked privilege', () => {
  // Two mechanisms because they bind different people: the REVOKE binds every non-owner, the
  // trigger binds everyone including the owner and a superuser with a psql session.
  assert.match(sql, /create trigger postings_immutable\s+before update or delete on postings/)
  assert.match(sql, /revoke update, delete, truncate on postings from public/)
  assert.match(sql, /grant select, insert on postings to public/)
  assert.doesNotMatch(sql, /grant update on postings/)
})

test('INVARIANT 3: a correction is a new entry, and an entry cannot reverse itself', () => {
  assert.match(sql, /reverses_entry_id\s+uuid\s+references journal_entries \(id\)/)
  assert.match(sql, /journal_entries_no_self_reversal_chk/)
})

test('INVARIANT 4: idempotency_key is unique on journal_entries', () => {
  assert.match(sql, /constraint journal_entries_idempotency_key_uniq unique \(idempotency_key\)/)
})

test('INVARIANT 5: the overdraft check consults the account, and clears suspense/clearing', () => {
  assert.match(sql, /may not go negative without overdraft_allowed/)
  assert.match(sql, /acct\.overdraft_allowed or acct\.purpose = 'suspense'/)
})

test('INVARIANT 5 fires AFTER, because the projection is written as a delta', () => {
  // Postgres fires BEFORE INSERT row triggers before it detects an ON CONFLICT conflict, so a
  // BEFORE trigger would see the raw delta rather than the resulting balance and refuse every
  // debit. It would also *appear* to work, because a debit against an account with no balance row
  // fails for the right reason by accident. This assertion is the guard on that.
  assert.match(sql, /create trigger balances_no_overdraft\s+after insert or update on balances/)
  assert.doesNotMatch(sql, /create trigger balances_no_overdraft\s+before/)
})

/**
 * **INVARIANT 6: a reconciliation of an on-chain asset cannot pass without a chain observation.**
 *
 * The other five are about the books being consistent. This one is about the books being TRUE, and
 * it is the one the estate's economics rest on: `docs/ecosystem/00-current-state.md:22` — "Custodial
 * EMBER can be minted with no chain movement."
 *
 * It is asserted here, against the migration TEXT, as well as behaviourally against a live database
 * in `reconcile.test.ts`. That is not duplication. The behavioural tests prove the rule holds in the
 * schema this build produces; these prove the statements are still IN the migration, so deleting one
 * fails loudly rather than leaving a suite that passes because it never exercised the deleted line.
 * Migration 9 shipped with `observed_source in ('liability_sum','indexer')` and a comment explaining
 * that the indexer did not exist yet; the comment stopped being true and the constraint did not
 * follow, which is precisely the failure mode a text assertion catches.
 */
test('INVARIANT 6: liability_sum is refused for an on-chain asset, by a trigger that reads chain_assets', () => {
  // A CHECK cannot reference another table, so this rule must be a trigger. Asserting the trigger
  // exists AND that it is BEFORE INSERT OR UPDATE: covering INSERT alone would leave
  // `update reconciliation_runs set observed_source = 'liability_sum'` as an open door.
  assert.match(
    sql,
    /create trigger reconciliation_runs_chain_observation_trg\s+before insert or update on reconciliation_runs/,
  )
  assert.match(sql, /if new\.observed_source = 'liability_sum'\s+and exists \(select 1 from chain_assets/)
  // It must raise a check violation, not a bare error, so a caller cannot tell it from a CHECK.
  assert.match(sql, /using errcode = '23514'/)
})

test('INVARIANT 6: an unobserved run is failed, and its numbers are NULL rather than zero', () => {
  // Absence of evidence must not read as evidence. `freezesWithdrawals('failed')` is true and only
  // 'clean' lifts a freeze, so these three lines are what make an unobservable asset unwithdrawable.
  assert.match(sql, /reconciliation_runs_unobserved_failed_chk check \(\s*observed_source <> 'unavailable' or status = 'failed'\s*\)/)
  assert.match(sql, /reconciliation_runs_unobserved_chk check \(\s*\(observed_source = 'unavailable'\) = \(indexer_observed_total is null\)\s*\)/)
  assert.match(sql, /reconciliation_runs_drift_chk check \(\s*\(indexer_observed_total is null\) = \(drift is null\)\s*\)/)

  // NULL has to be reachable for any of the above to mean anything. Migration 9 declared both
  // columns `not null default 0`, which is exactly how "we did not look" became "the chain holds
  // nothing" — so the drop is load-bearing, not tidying.
  assert.match(sql, /alter column indexer_observed_total drop not null/)
  assert.match(sql, /alter column drift drop not null/)
  assert.match(sql, /alter column indexer_observed_total drop default/)
  assert.match(sql, /alter column drift drop default/)
})

test('INVARIANT 6: the chain asset list is data, not text baked into a constraint', () => {
  // Two reasons this must be a table, and the second one is a landmine rather than a preference:
  //
  //   * a CHECK cannot reference another table, and inlining the codes would be a second copy of
  //     ON_CHAIN_ASSETS free to drift from the first;
  //   * migration text is CHECKSUMMED (@cloudsforge/db `checksumOf`), so generating the list into
  //     the SQL from the imported constant would mean adding a sixth chain asset silently altered
  //     an APPLIED migration and every deployment refused to start.
  //
  // So the codes appear as INSERTed rows and nowhere else. If a future edit inlines them into the
  // constraint, this fails.
  assert.match(sql, /insert into chain_assets \(asset_code, note\) values/)
  assert.doesNotMatch(sql, /observed_source in \([^)]*'liability_sum'[^)]*\)\s*and\s*asset_code in/i)

  const version11 = MIGRATIONS.find((m) => m.name === 'chain_backed_reconciliation')
  assert.ok(version11, 'migration 11 is missing')
  // The list is imported into the SERVICE from contracts-chain; the database copy is seeded once
  // here. `reconcile.test.ts` asserts the two are equal against a live table.
  assert.doesNotMatch(version11.up, /\$\{/, 'migration text must be a literal — an interpolated list would change its checksum')
})

/* ------------------------------------------------------------------ shape */

test('the account key is unique, which is what stops one balance splitting across two rows', () => {
  assert.match(sql, /create unique index if not exists accounts_key_uniq\s+on accounts \(subject, asset_code, purpose\)/)
})

test('amounts are numeric(78,0) — never a float, anywhere', () => {
  assert.match(sql, /amount\s+numeric\(78,0\)\s+not null/)
  // 'real', 'double precision', 'float' and 'money' must not appear as a column type anywhere.
  // Asserted against the statements, not the prose: the comments discuss `contracts-money`.
  assert.doesNotMatch(statementsOf(sql), /\b(real|double precision|float\d*|money)\b\s*(not null|,|\))/i)
  // The old ledger encoded direction in the sign of the amount. Here direction has its own column
  // and the magnitude is constrained positive.
  assert.match(sql, /constraint postings_amount_positive_chk check \(amount > 0\)/)
})

test('the entry kind constraint lists exactly the closed set from contracts-money', () => {
  const constraint = /journal_entries_kind_chk check \(kind in \(([\s\S]*?)\)\)/.exec(sql)
  assert.ok(constraint, 'the kind constraint is missing')
  const listed = [...constraint[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
  // Both directions. A kind in the database that contracts-money does not know is unpostable; a
  // kind in contracts-money the database refuses is a 500 waiting for the first caller to use it.
  assert.deepEqual([...listed].sort(), [...ENTRY_KINDS].sort())
})

test('the balances shadow carries no overdraft trigger, so a rebuild cannot suppress its own finding', () => {
  const shadow = MIGRATIONS.find((m) => m.name === 'balances_shadow')
  assert.ok(shadow)
  assert.doesNotMatch(statementsOf(shadow.up), /trigger/i)
  assert.doesNotMatch(statementsOf(shadow.up), /references accounts/i)
})

/* ------------------------------------------------------ migration 13, the retired-asset guard */

/**
 * The kinds migration 13 refuses a retired asset on, read out of the SQL rather than restated.
 *
 * A narrow parse that fails loudly. A regex that quietly matched nothing would make every
 * assertion below vacuous, which is the exact failure mode the guard itself exists to avoid.
 */
function acquisitionKindsInSql(): readonly string[] {
  const guard = MIGRATIONS.find((m) => m.name === 'retired_asset_guard')
  assert.ok(guard, 'migration 13 is missing')
  const clause = /if entry_kind in \(([^)]*)\) then/.exec(guard.up)
  assert.ok(clause?.[1], 'the kind list could not be read out of migration 13')
  return [...clause[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
}

test('every kind migration 13 names is a real entry kind, so the rule cannot match nothing', () => {
  const listed = acquisitionKindsInSql()
  assert.ok(listed.length > 0)
  for (const kind of listed) {
    // A typo here does not fail: it produces a comparison that is simply never true, and a guard
    // that silently never fires. `journal_entries_kind_chk` is the closed vocabulary, so membership
    // of ENTRY_KINDS is the whole test.
    assert.ok(ENTRY_KINDS.includes(kind as never), `migration 13 names '${kind}', which is not an entry kind`)
  }
})

test('the SQL and the application agree about which kinds are acquisitions', () => {
  // Two copies, deliberately: the database is the enforcement point and the application is what
  // gives a caller a named diagnosis before a connection is taken. They may not disagree, or a
  // caller is told one thing and refused for another.
  assert.deepEqual([...acquisitionKindsInSql()].sort(), [...ACQUISITION_KINDS].sort())
})

test('the retired set is seeded as ROWS, never inlined into the rule', () => {
  const guard = MIGRATIONS.find((m) => m.name === 'retired_asset_guard')!
  // The same discipline migration 11 applies to chain_assets, and for the same two reasons: an
  // inline list is a second declaration of RETIRED_ASSETS free to drift, and generating one into
  // this string would change an APPLIED migration's checksum the day a second asset is wound down.
  assert.match(guard.up, /insert into retired_assets \(asset_code, retired_on, note\) values/)
  assert.doesNotMatch(
    statementsOf(guard.up).replace(/insert into retired_assets[\s\S]*?on conflict[^;]*;/, ''),
    /'SHARD'/,
    'the retired asset is named outside its seed row — that is the second list this design avoids',
  )
  // Every code seeded must be one contracts-chain actually retired. `entries.test.ts` asserts the
  // other direction against the live table.
  const seeded = [...statementsOf(guard.up).matchAll(/\('([A-Z]+)',\s*\n?\s*date '/g)].map((m) => m[1]!)
  assert.deepEqual(seeded.sort(), [...RETIRED_ASSETS].sort())
})

test('retired_assets cannot be emptied by anyone who is not the table owner', () => {
  const guard = MIGRATIONS.find((m) => m.name === 'retired_asset_guard')!
  // Without this, "make the charge go through" is one DELETE away, and the row that says an asset
  // is wound down is the only thing standing between a retired unit and a customer's balance.
  assert.match(guard.up, /revoke update, delete, truncate on retired_assets from public/)
})
