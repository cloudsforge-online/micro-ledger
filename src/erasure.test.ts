/**
 * Right to erasure — micro-org#534, the journal's half.
 *
 * The estate's rule is that everything is anonymised (`deploy/erasure/register.psv`), and here it
 * is not a preference: a posting whose account has been deleted is a debit with no counterpart, and
 * a journal you can delete a party out of is not a record. So the cases below are about what
 * SURVIVES as much as about what changes.
 *
 * `subjectColumns` is the load-bearing one. It asks `information_schema` which tables have a
 * `subject` column at all, and asserts the answer is exactly `accounts` — because the whole reason
 * one UPDATE is sufficient is that nothing else denormalises it. A migration that adds
 * `postings.subject` for a reporting query turns this red rather than leaking quietly.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { eraseSubject } from './erasure.ts'
import type { Db, Tx } from './outbox.ts'
import { ALICE, BOB, enabled, migrateTestDb, openDb, resetLedger, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
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

/** Every base table with a column literally named `subject`. */
async function subjectColumns(): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type = 'BASE TABLE'
       and c.column_name = 'subject'
     order by c.table_name
  `
  return rows.map((row) => row.table_name)
}

/** Every base table still containing the raw uuid anywhere in any column. */
async function tracesOf(needle: string): Promise<string[]> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name
  `
  const found: string[] = []
  for (const { table_name: table } of tables) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(table)} t where t::text like ${`%${needle}%`}
    `
    if ((rows[0]?.n ?? 0) > 0) found.push(table)
  }
  return found
}

async function openAccount(subject: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into accounts (subject, type, asset_code, purpose)
    values (${subject}, 'liability', 'EMBER', 'available')
    returning id
  `
  return rows[0]!.id
}

test('accounts is the ONLY table with a subject, which is why one UPDATE is enough', { skip }, async () => {
  assert.deepEqual(
    await subjectColumns(),
    ['accounts'],
    'a table now denormalises the subject — wire it into eraseSubject or this erasure is partial',
  )
})

test('the account is RETAINED and only its subject changes', { skip }, async () => {
  const id = await openAccount(ALICE)
  const bare = ALICE.slice('user:'.length)
  assert.ok((await tracesOf(bare)).length > 0, 'the fixture must actually hold the subject')

  const outcome = await (sql as unknown as Db).begin(async (tx) =>
    eraseSubject(tx as unknown as Tx, ALICE),
  )
  assert.equal(outcome.accounts, 1)

  const kept = await sql<{ id: string; subject: string; type: string; purpose: string }[]>`
    select id, subject, type, purpose from accounts where id = ${id}
  `
  assert.equal(kept.length, 1, 'the account survives — every posting references it')
  assert.match(kept[0]!.subject, /^erased:/, 'and the person is gone from it')
  assert.equal(kept[0]!.type, 'liability', 'the account type is a fact about an account')
  assert.equal(kept[0]!.purpose, 'available')
  assert.deepEqual(await tracesOf(bare), [], 'nothing in the schema still names the subject')
})

test('it anonymises the subject it names and nobody else', { skip }, async () => {
  await openAccount(ALICE)
  await openAccount(BOB)

  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, ALICE))

  const survivors = await sql<{ n: number }[]>`
    select count(*)::int as n from accounts where subject = ${BOB}
  `
  assert.equal(survivors[0]?.n, 1, 'the other subject keeps their account')
})

test('one placeholder covers all of a person’s accounts, so one party stays one party', { skip }, async () => {
  await openAccount(ALICE)
  await sql`
    insert into accounts (subject, type, asset_code, purpose)
    values (${ALICE}, 'liability', 'EMBER', 'reserved')
  `
  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, ALICE))

  const subjects = await sql<{ subject: string }[]>`select distinct subject from accounts`
  assert.equal(subjects.length, 1, 'two accounts, one placeholder — three would be three parties')
})

test('a second pass is a no-op, which is what makes a replay safe', { skip }, async () => {
  await openAccount(ALICE)
  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, ALICE))
  const second = await (sql as unknown as Db).begin(async (tx) =>
    eraseSubject(tx as unknown as Tx, ALICE),
  )
  assert.equal(second.accounts, 0)
  assert.equal(second.outbox, 0)
})
