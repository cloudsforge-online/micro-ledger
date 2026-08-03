/**
 * The indexer, as this service uses it: one number, and one rule about what may become one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE RULE
 *
 * **UNREACHABLE ARRIVES AS `undefined`, NEVER AS `0n`.**
 *
 * `0n` and `undefined` reach `reconcileAsset` as different questions — "the chain holds nothing"
 * and "nobody could look" — and migration 11 makes the database enforce the difference. A
 * transport that collapsed them would reinstate, one layer lower, the exact defect this release
 * removed: a reconciliation that reports a number it never measured.
 *
 * There is exactly one path out of this module that returns a number, and it requires all of:
 *
 *   * a **200**. Every refusal on the custody route is a 4xx or a 5xx carrying a fault code, and
 *     those codes are the operator's diagnosis, not a fallback signal;
 *   * a body whose `total` is a **string**. A JSON number has already lost the low digits of an
 *     18-decimal balance by the time `JSON.parse` returns, and those digits are exactly where a
 *     reconciliation drift lives — `7000000000000000000` survives, `7000000000000000001` does not;
 *   * a string matching `^(0|[1-9][0-9]*)$`. **`BigInt('')` is `0n`**, which is how an empty answer
 *     becomes a confident statement that the chain holds nothing. `'0x1a'`, `'-1'` and `'7e18'` are
 *     each accepted by some parser in this language and none of them is a total.
 *
 * Everything else — a timeout, a refused connection, DNS, a 401 from a missing grant, a 403, a 503
 * from a halted chain, a body that does not parse, `{total: 0}`, `{total: ''}`, `{total: null}` —
 * is `undefined`. `reconcileAsset` then records `unavailable` / `failed`, which freezes the asset
 * and which no later unobserved run can lift. **That is the correct outcome**: an asset whose
 * backing nobody can see is an asset nobody should be able to withdraw. What must never happen is
 * the other thing, and the other thing is one `?? 0n` away.
 *
 * The properties above are not asserted only here. They were specified and proved against a real
 * socket, a real indexer and a real chain in `indexer/src/chainbacking.test.ts` before this file
 * existed — that file's `observedTotalFor` is this function's reference implementation — and
 * `indexerclient.test.ts` beside this one re-proves each of them against this code, because a
 * property proved of a reference and then reimplemented is a property that has been described,
 * not held.
 *
 * ## Why `HttpClient` rather than the reference's bare `fetch`
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * It is the estate's outbound convention: one absolute deadline across the whole call rather than
 * a per-socket one, redaction in error messages, and result events the composition root turns into
 * metrics. A hand-rolled `fetch` in this repository would be the fifth place in the estate that
 * has to remember `AbortSignal`.
 *
 * And `deploy/scripts/derive-grants.mjs` **reads a module's outbound demand off its source**, with
 * `new HttpClient(` plus a named bearer as the discriminator. A file that calls bare `fetch` and
 * exports `INDEXER_SCOPES` contributes nothing to the derivation and does so SILENTLY — no grant,
 * no error, and a 401 for the life of the deployment. The declaration below is what provisions the
 * grant; a shape the deriver cannot read is a declaration that does not exist.
 *
 * ## What is deliberately absent
 *
 * **No retry.** `retries: 0`, against `HttpClient`'s default of two for a GET. A retry inside the
 * handler spends the job's lease on an outage; the reconciliation job runs again in fifteen
 * minutes, and a freeze that lifts on the next clean observed run is the retry.
 *
 * **No fallback, of any kind.** Not a cached previous total, not the ledger's own liability sum,
 * not zero. Each of those is a check that cannot fail, on the one asset this whole release is
 * about.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, type ResultEvent } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'
import { ON_CHAIN_ASSETS, type Network } from '@cloudsforge/contracts-chain'

/**
 * The scopes this service's token must carry to call the indexer.
 *
 * `GET /v1/custody/:chain/:network/total` is the ONE domain read on that service which demands a
 * token (`indexer/src/server.ts:582`), and the argument for the exception is why this constant
 * exists: every other read answers a question about a block, a hash or an address the caller
 * already named, and naming it is what makes the answer public. This one answers a question about
 * a SET only the platform knows — the size of the estate's custody position — so serving it
 * anonymously would publish the treasury's size to anyone who can reach the port.
 *
 * `indexer:write` is deliberately NOT here. This service registers no address and must never learn
 * which addresses are custody's; the route answers one number for exactly that reason.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`, following settlement, wallet, mint and
 * trade: a scope the registry does not have, or one it has DEPRECATED, is then a compile error in
 * this file rather than an identity container that refuses to boot on the value micro-deploy
 * derived from it.
 */
export const INDEXER_SCOPES: readonly LiveScope[] = Object.freeze(['indexer:read'])

/**
 * The chain slug the indexer's URLs use, for an asset this service reconciles.
 *
 * The indexer's `ChainId` is "the asset code lowercased, which is also what `txUrn` uses, so a path
 * segment and a cross-service URN cannot drift apart" (`indexer/src/chains.ts:32`). That is read
 * and applied here rather than restated as a second map: a hand-written table would be a copy of a
 * fact that lives in another repository, and copies rot silently — which is the finding that
 * produced `derive-grants.mjs` in the first place.
 *
 * `undefined` for anything with no chain behind it. The caller must not ask the indexer about
 * SHARD: it is in `CHAINS` only so that record is total, the indexer refuses the slug outright
 * (`chains.ts:37` — "an indexer that accepted it would be advertising an endpoint that can only
 * ever answer empty"), and a 404 there would be read here as an unobservable asset and freeze
 * something that has no chain to be backed by.
 */
export function indexerChainFor(assetCode: string): string | undefined {
  return ON_CHAIN_SLUGS.get(assetCode)
}

/**
 * Built from `ON_CHAIN_ASSETS`, so an asset added to the estate's chain list gets a slug without
 * anything here being edited, and an asset removed from it stops having one.
 */
const ON_CHAIN_SLUGS: ReadonlyMap<string, string> = new Map(
  (ON_CHAIN_ASSETS as readonly string[]).map((code) => [code, code.toLowerCase()]),
)

export interface IndexerClientOptions {
  readonly baseUrl: string
  /**
   * The service token, resolved per call.
   *
   * A function rather than a string so a short-TTL credential can be refreshed without rebuilding
   * the client. **May resolve to `undefined`**, and that case is not an error here: an unauthorised
   * call gets a 401, which maps to `undefined`, which freezes. See `env.ts` on why a missing token
   * must not stop this service booting.
   */
  readonly token: () => Promise<string | undefined> | string | undefined
  /** Absolute wall-clock ceiling on the whole call, including connect. */
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
  readonly onResult?: (event: ResultEvent) => void
}

export interface IndexerClient {
  /**
   * Σ confirmed native balance over the indexer's custody set, in the asset's smallest units.
   *
   * `undefined` means **no observation**, for any reason whatsoever. It never means zero.
   */
  observedTotalFor(chain: string, network: Network): Promise<bigint | undefined>
}

/**
 * A 2xx that is not 200.
 *
 * `HttpClient.request` returns a parsed body for every `res.ok` and does not surface the status, so
 * without this a `202` or a `206` carrying a plausible body would reach the parser below and could
 * become a total. Thrown from the `fetch` seam rather than tracked in a variable on the client,
 * because the client is shared across concurrently reconciling assets and a "last status" field
 * would be a race — one whose only symptom would be a wrong number on a solvency check.
 *
 * `HttpClient` classifies this as a transport error, which with `retries: 0` reaches the caller
 * unchanged and becomes `undefined` like every other refusal.
 */
class NotExactly200Error extends Error {
  constructor(status: number) {
    super(`the custody total is a 200 or it is not an answer (got ${status})`)
    this.name = 'NotExactly200Error'
  }
}

export function httpIndexerClient(options: IndexerClientOptions): IndexerClient {
  const underlying = options.fetch ?? globalThis.fetch
  const exactly200: typeof globalThis.fetch = async (input, init) => {
    const response = await underlying(input, init)
    if (response.ok && response.status !== 200) {
      // Release the socket rather than leaving the body unread and the connection pinned.
      await response.body?.cancel().catch(() => {})
      throw new NotExactly200Error(response.status)
    }
    return response
  }

  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    defaultRetries: 0,
    token: options.token,
    fetch: exactly200,
    ...(options.onResult ? { onResult: options.onResult } : {}),
  })

  return {
    async observedTotalFor(chain, network) {
      let body: unknown
      try {
        body = await client.get<unknown>(
          `/v1/custody/${encodeURIComponent(chain)}/${encodeURIComponent(network)}/total`,
          { retries: 0 },
        )
      } catch {
        // Every failure, without exception and without inspection: a timeout, a refused
        // connection, DNS, a 401, a 403, a 503 with a fault code, a body that is not JSON, an open
        // circuit, a 2xx that is not 200. There is deliberately no branch here that distinguishes
        // them, because every branch that could be added is a branch that could return a number.
        // The DIAGNOSIS is the indexer's fault code and this client's `onResult` event, both of
        // which reach an operator; the ANSWER is "nobody looked".
        return undefined
      }
      return totalFrom(body)
    },
  }
}

/**
 * The parse, exported so the property tests can drive it directly as well as over a socket.
 *
 * Order matters and is the whole of it: `typeof total === 'string'` comes FIRST, because without it
 * a JSON number reaches `BigInt`, which accepts an integral one and silently blesses a value that
 * `JSON.parse` has already rounded.
 */
export function totalFrom(body: unknown): bigint | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const total = (body as { total?: unknown }).total
  if (typeof total !== 'string' || !/^(0|[1-9][0-9]*)$/.test(total)) return undefined
  return BigInt(total)
}
