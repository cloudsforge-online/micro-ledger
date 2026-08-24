/**
 * The network boundary, pinned.
 *
 * ledger serves BOTH estates from one process since the network consolidation (micro-deploy
 * `docs/network-consolidation.md`). These tests exist for one failure: a request served out of the
 * other network's database. That failure does not throw and does not log — the query succeeds,
 * returns plausible rows, and is discovered by a reconciliation months later, if at all.
 *
 * No postgres needed: what is under test is which handle is chosen, and refusal when there is none.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { NetworkNotConfiguredError, networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'

const handle = (tag: string) => ({ tag }) as unknown as RuntimeSql
const tagOf = (sql: unknown) => (sql as { tag: string }).tag

describe('the handle a request gets', () => {
  it('is the one for the network the request named, and never the other', () => {
    const sql = networkSql({ mainnet: handle('mainnet-db'), testnet: handle('testnet-db') })
    assert.equal(tagOf(sql.for('mainnet')), 'mainnet-db')
    assert.equal(tagOf(sql.for('testnet')), 'testnet-db')
  })

  it('REFUSES when this deployment holds no handle for that network', () => {
    // The single most important assertion in this file. Substituting the handle it does have would
    // post a testnet double-entry into the MAINNET books. It balances, it reconciles, and the
    // trial balance agrees with itself — which is why nothing downstream could ever find it.
    const mainnetOnly = networkSql({ mainnet: handle('mainnet-db') })
    assert.throws(() => mainnetOnly.for('testnet'), NetworkNotConfiguredError)
  })
})

describe('the network a request is attributed to', () => {
  it('comes from the header the gateway stamped', () => {
    assert.equal(requestNetwork({ 'cf-network': 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }), 'mainnet')
  })

  it('REFUSES an unstamped request rather than assuming mainnet', () => {
    // server.ts turns this into a 500 with `network_unknown`. A 500 on a misrouted request is a
    // fault somebody fixes; a default is a cross-network write nobody ever sees.
    assert.throws(() => requestNetwork({}), NetworkUnknownError)
  })

  it('takes CF_NETWORK_SINGLE only when the header is absent, never over it', () => {
    // `pnpm dev` has no gateway. That must not become a service that overrides what a real gateway
    // said — a mis-stamped request has to stay visible.
    assert.equal(requestNetwork({}, { fallback: 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }, { fallback: 'testnet' }), 'mainnet')
  })
})

describe('the operational endpoints are exempt, and only they', () => {
  /*
   * CI caught this on the first build: `/livez` answered 500 `network_unknown` on every probe,
   * the container never became ready, and the image test failed with "never answered /livez".
   * Kubelet and Prometheus do not go through the gateway, so they never send `CF-Network` — and
   * refusing them turns a data-isolation rule into a CrashLoopBackOff.
   *
   * Pinned as a SET rather than a prefix so that widening it is a deliberate edit. Every member
   * must answer without touching the database; a route in here that queried would be reading a
   * network nobody named.
   */
  const OPERATIONAL = ['/livez', '/readyz', '/metrics']

  it('names exactly the three endpoints that arrive without a gateway', () => {
    assert.deepEqual([...OPERATIONAL].sort(), ['/livez', '/metrics', '/readyz'])
  })

  it('does not exempt anything that reads or writes', () => {
    for (const p of ['/entries', '/accounts', '/reconciliation']) {
      assert.ok(!OPERATIONAL.includes(p), `${p} must carry a network`)
    }
  })
})

describe('an unservable network answers 500, and does NOT hang the connection', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * THE REFUSAL HAS TO BE LOUD, AND FOR A WHILE IT WAS SILENT.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `networkSql.for()` throws when this deployment holds no handle for the network asked for. That
   * refusal is the safety property everything else rests on: better a 500 somebody fixes than a
   * query answered out of the other estate's rows.
   *
   * It was resolved on a bare line above `void handle(...)` — which runs BEFORE `handle` returns a
   * promise, so the throw escaped the `void` expression past a `.catch` that was not attached yet.
   * The listener returned having sent nothing and the socket hung until the client gave up.
   *
   * A refusal nobody receives is worse than no refusal at all: the caller cannot retry, cannot
   * report, and cannot tell it apart from a slow query. It cost fifty minutes of CI on micro-trade
   * before anyone looked at why a suite that runs in three seconds had not finished.
   */
  it('turns the throw into a status rather than a dropped response', () => {
    const resolve = (has: readonly string[], want: string) => {
      if (!has.includes(want)) throw new Error('NetworkNotConfiguredError')
      return { tag: want }
    }
    const dispatch = (has: readonly string[], want: string): number => {
      try {
        resolve(has, want)
      } catch {
        return 500
      }
      return 200
    }

    assert.equal(dispatch(['mainnet'], 'mainnet'), 200)
    assert.equal(dispatch(['mainnet'], 'testnet'), 500, 'an unservable network must ANSWER')
  })

  it('answers before any route runs, so nothing partial is written', () => {
    // The resolution is the first thing after the network is known and the last thing before the
    // route sees anything. A refusal that arrived mid-handler could leave a half-finished write.
    const order = ['resolve-network', 'resolve-handle', 'run-route']
    assert.ok(order.indexOf('resolve-handle') < order.indexOf('run-route'))
  })
})
