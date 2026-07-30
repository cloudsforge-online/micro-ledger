import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { ENTRY_KINDS } from '@cloudsforge/contracts-money'
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
