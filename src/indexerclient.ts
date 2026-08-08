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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE SECOND RULE, ADDED AFTER A FREEZE THAT COULD NOT BE READ
 *
 * **THE ANSWER IS STILL "NOBODY LOOKED". THE RUN MUST ALSO RECORD *WHY* NOBODY LOOKED.**
 *
 * The paragraph above used to end "there is deliberately no branch here that distinguishes them",
 * and as a rule about the ANSWER that is still exactly right and is enforced below. As a rule
 * about the DIAGNOSIS it was wrong, and the estate paid for it:
 *
 *   `LEDGER_SERVICE_TOKEN` was a 600-second token read once at boot; the reconciliation job runs
 *   every 900 seconds. From minute ten of every deployment the custody call 401'd, mapped to
 *   `undefined`, recorded `unavailable` / `failed` and froze EMBER — **producing byte-identical
 *   rows, logs and events to the honest "Hearth has not launched, so nothing can be observed"
 *   freeze this file was written to produce.** A guarantee built to stop the ledger lying to itself
 *   was reporting a true-shaped fact for a false reason, and no operator could have told.
 *
 * `env.ts` fixes the cause — the service now holds a credential and mints its own tokens. This
 * fixes the legibility, which is a separate defect and outlives the first one: an expired token is
 * only one of the ways authentication fails, and the next one will be silent again unless the row
 * says which happened.
 *
 * So `observe()` returns the same `bigint | undefined` **plus** an `UnobservedReason`, and the two
 * come from structurally separate places: `total` is assigned in exactly one statement, from
 * `totalFrom`, and `reasonFor` is a pure function of a caught error that **cannot see or produce a
 * number**. That separation is the guard the old comment was really asking for. Adding a branch
 * that could return a number is still forbidden; adding a branch that says why there is none is
 * what an operator needs at three in the morning.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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

import { CircuitOpenError, HttpClient, HttpError, TimeoutError, type ResultEvent } from '@cloudsforge/http'
import { ServiceTokenUnavailableError } from '@cloudsforge/auth'
import type { LiveScope } from '@cloudsforge/contracts-auth'
import { ON_CHAIN_ASSETS, type Network } from '@cloudsforge/contracts-chain'

/**
 * The scopes this service's token must carry to call the indexer.
 *
 * `GET /v1/custody/:chain/:network/total` is the ONE domain read on that service which demands a
 * token (`indexer/src/server.ts`), and the argument for the exception is why this constant
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
 * segment and a cross-service URN cannot drift apart" (`indexer/src/chains.ts`). That is read
 * and applied here rather than restated as a second map: a hand-written table would be a copy of a
 * fact that lives in another repository, and copies rot silently — which is the finding that
 * produced `derive-grants.mjs` in the first place.
 *
 * `undefined` for anything with no chain behind it. The caller must not ask the indexer about
 * SHARD: it is in `CHAINS` only so that record is total, the indexer refuses the slug outright
 * (`chains.ts` — "an indexer that accepted it would be advertising an endpoint that can only
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

/**
 * Why a run has no observation. **A diagnosis, never an answer** — nothing downstream may treat any
 * of these as a number, and `reconcileAsset` records the same NULL total and the same `failed`
 * status for every one of them.
 *
 * The set is chosen so that each value sends an operator to a different place on the first read.
 * The split that matters most, and the one this whole change exists for, is the first group against
 * the last two: **`no_credential` and `unauthorized` are faults in THIS platform's authentication.
 * `indexer_error` is the indexer saying it cannot see the chain.** Those were one row.
 *
 *   * `not_configured`      — no `INDEXER_URL` in this deployment. Nothing was dialled. Deploy fix.
 *   * `no_credential`       — this process could not obtain a service token at all: no
 *                             `LEDGER_IDENTITY_CREDENTIAL`, identity unreachable, or identity
 *                             refusing the exchange. **The request was never sent**, deliberately —
 *                             sending it unauthenticated would come back 401 and blame the indexer.
 *   * `unauthorized`        — a token was presented and the indexer refused it (401/403), and the
 *                             provider had already re-minted and replayed once. That is a GRANT
 *                             problem: `indexer:read` derived from `INDEXER_SCOPES` below.
 *   * `timeout`             — the deadline ended the call. The indexer may be healthy and slow.
 *   * `unreachable`         — no HTTP answer at all: refused connection, DNS, an open circuit.
 *   * `indexer_error`       — the indexer answered 5xx. **This is where the honest "the chain could
 *                             not be observed" lives**: the estate's route answers 503
 *                             `chain_not_followed` when no node is followed for the asset.
 *   * `indexer_refused`     — a non-auth 4xx. We asked something it will not answer: an unknown
 *                             chain slug, a network it does not carry.
 *   * `unusable_answer`     — a 200 whose body is not a decimal-string total. Either a version skew
 *                             or something that is not the indexer on the far end of that URL.
 */
export const UNOBSERVED_REASONS = Object.freeze([
  'not_configured',
  'no_credential',
  'unauthorized',
  'timeout',
  'unreachable',
  'indexer_error',
  'indexer_refused',
  'unusable_answer',
] as const)

/**
 * Derived from the array rather than declared beside it, so the list a test enumerates and the type
 * the compiler enforces are the same object. Two declarations would drift, and the drift would be
 * invisible: a reason the schema had never been shown to accept would abort the reconciliation
 * transaction — on the estate's solvency check — the first time it was produced.
 */
export type UnobservedReason = (typeof UNOBSERVED_REASONS)[number]

/**
 * One attempt to read the chain half of the invariant.
 *
 * The two fields are exclusive by construction — `total` is present exactly when `reason` is `null`
 * — and they are built in separate statements from separate inputs so that no future edit can make
 * a reason produce a total. See the header.
 */
export interface Observation {
  /** `undefined` means **no observation**, for any reason whatsoever. It never means zero. */
  readonly total: bigint | undefined
  /** `null` exactly when `total` is a number. */
  readonly reason: UnobservedReason | null
  /**
   * Where the observed side sits, split by custody label — **prose, and nothing else.**
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * `deposit: 41000000 over 12 addresses, treasury: 9000000 over 1`. It exists so a freeze can name
   * its own cause: deposits and treasury float are different money held by different code, and a
   * drift in one is a different incident from a drift in the other. The 2026-08-05 freeze was a
   * treasury registration and read, from the message, exactly like a deposit-sweep shortfall.
   *
   * **Typed `string`, which is the safety property and not a convenience.** `Observation` is the
   * type the reconciliation's arithmetic is built from, and this module's whole discipline is that
   * `totalFrom` is the only thing in it that can produce a number. A `readonly buckets: bigint[]`
   * would put a second numeric member on the type the solvency check reads, and the next edit that
   * summed it — as a cross-check, as a fallback when `total` is missing, as anything — would be
   * comparing the ledger against a figure this file never validated as a total. A string has no
   * such affordance. It is built by `breakdownFrom` below, which is pure, bounded, and cannot
   * return anything the schema has not been shown.
   *
   * `null` whenever the answer carried no usable breakdown, and a missing breakdown is never a
   * reason to withhold a total: the split is a diagnosis, and an indexer too old to send one still
   * knows what the chain holds.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly breakdown: string | null
}

export interface IndexerClientOptions {
  readonly baseUrl: string
  /**
   * The service token, resolved per call.
   *
   * A function rather than a string so a short-TTL credential can be refreshed without rebuilding
   * the client — and since `upstreams.ts` this is `ServiceTokenProvider.token`, which mints one
   * from a long-lived credential and re-mints at ~80% of its life. That is what stops the fifteen-
   * minute sweep meeting a ten-minute token.
   *
   * **May resolve to `undefined`**, and that case is not an error here: an unauthorised call gets a
   * 401, which is `unauthorized`, which freezes. It may also **reject** — `ServiceTokenUnavailable
   * Error` when there is no credential or identity is down — and that is `no_credential`, with no
   * request sent. Neither may stop this service booting: see `env.ts`.
   */
  readonly token: () => Promise<string | undefined> | string | undefined
  /** Absolute wall-clock ceiling on the whole call, including connect. */
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
  readonly onResult?: (event: ResultEvent) => void
}

export interface IndexerClient {
  /**
   * Σ confirmed native balance over the indexer's custody set, in the asset's smallest units, and
   * — when there is none — why not.
   *
   * This is what `jobs.ts` calls. `observedTotalFor` below is the same call with the diagnosis
   * discarded, kept because it is the shape the contract is stated and proved in.
   */
  observe(chain: string, network: Network): Promise<Observation>
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

  const self: IndexerClient = {
    async observe(chain, network) {
      let body: unknown
      try {
        body = await client.get<unknown>(
          `/v1/custody/${encodeURIComponent(chain)}/${encodeURIComponent(network)}/total`,
          { retries: 0 },
        )
      } catch (err) {
        // Every failure, without exception: a timeout, a refused connection, DNS, a 401, a 403, a
        // 503 with a fault code, a body that is not JSON, an open circuit, a 2xx that is not 200.
        // **There is still no branch here that can produce a number** — this `return` is the only
        // statement in the function reachable from a caught error, and it is a literal `undefined`.
        // `reasonFor` is handed the error and can answer with one of eight strings; it never sees
        // the body and has no path to `totalFrom`.
        return { total: undefined, reason: reasonFor(err), breakdown: null }
      }
      // The one statement in this module that yields a number, and `totalFrom` is the only thing
      // that decides. `undefined` here means a 200 arrived and was not a total — a different fact
      // from every case above, and one an operator diagnoses at the indexer rather than at identity.
      const total = totalFrom(body)
      return total === undefined
        ? { total: undefined, reason: 'unusable_answer', breakdown: null }
        : { total, reason: null, breakdown: breakdownFrom(body) }
    },

    async observedTotalFor(chain, network) {
      return (await self.observe(chain, network)).total
    },
  }
  return self
}

/**
 * The diagnosis, and **only** the diagnosis.
 *
 * Pure, total, and typed to return `UnobservedReason` — a string union with no numeric member — so
 * the compiler enforces the property the header claims: nothing in this function can become a
 * total. It is exported so the tests can enumerate its cases without a socket, and driven over real
 * sockets by `chainbacking.test.ts`.
 *
 * Order matters once: `ServiceTokenUnavailableError` is checked FIRST. It is thrown by the token
 * supplier inside `HttpClient`'s attempt, so it arrives as an ordinary rejection with no status and
 * would otherwise fall through to `unreachable` — reporting the indexer as unreachable when the
 * request was never sent and the fault is identity's. That misattribution is a smaller copy of the
 * one this whole change exists to remove.
 */
export function reasonFor(err: unknown): UnobservedReason {
  if (err instanceof ServiceTokenUnavailableError) return 'no_credential'
  if (err instanceof TimeoutError) return 'timeout'
  if (err instanceof CircuitOpenError) return 'unreachable'
  if (err instanceof HttpError) {
    // `HttpClient` reuses `HttpError` for "a 2xx whose body would not parse as JSON", carrying the
    // SUCCESSFUL status. Without this line that lands in the `!peerDecided` bucket and is reported
    // as a server error, sending an operator to the indexer's logs for something the indexer
    // considers a success. It is the same fact as a body that parses and is not a total.
    if (err.status < 400) return 'unusable_answer'
    if (err.status === 401 || err.status === 403) return 'unauthorized'
    return err.peerDecided ? 'indexer_refused' : 'indexer_error'
  }
  // A `fetch` that rejected: ECONNREFUSED, DNS, a socket hang-up, or `NotExactly200Error` above —
  // which is a peer answering something that is not an answer, and is reported as such.
  if (err instanceof NotExactly200Error) return 'unusable_answer'
  return 'unreachable'
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

/** At most this many buckets are rendered; see `breakdownFrom`. */
const MAX_BUCKETS = 8
/** A prefix longer than this is truncated. `deposit:` is eight characters. */
const MAX_PREFIX = 24

/**
 * The breakdown, rendered to prose here and never anywhere else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * Pure, total, and returns `string | null` — no numeric member, for the reason `Observation.breakdown`
 * gives at length. It is the sibling of `reasonFor`: one function whose job is to say something an
 * operator can act on, structurally unable to say anything the arithmetic could use.
 *
 * **Everything here is untrusted input that ends up in a database column and on an operator's
 * screen.** `asset_freezes.reason` is what the console shows first, so a hostile or simply broken
 * indexer answering with four thousand buckets, or a prefix containing newlines, would be writing
 * into an incident message. Hence: at most `MAX_BUCKETS` entries, each prefix clamped to
 * `MAX_PREFIX` characters with everything outside a conservative character class dropped, amounts
 * accepted only in the same decimal form `totalFrom` demands, and counts only as non-negative safe
 * integers. Anything that does not fit is not rendered — never repaired, never partially printed
 * with an ellipsis standing in for a number.
 *
 * **A dropped bucket would be a lie by omission**, since the whole claim of the phrase is that the
 * parts explain the total, so a body with more than `MAX_BUCKETS` buckets is refused entirely
 * rather than truncated to the first eight. The indexer asserts parts-equal-whole on its own side
 * (`custody.ts:groupByPrefix`) and this file does not re-derive it: re-deriving would mean summing
 * these figures, which is exactly the affordance the string type exists to remove.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function breakdownFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const buckets = (body as { byLabelPrefix?: unknown }).byLabelPrefix
  // An indexer too old to send one. Not an error, and not a reason to withhold the total.
  if (!Array.isArray(buckets) || buckets.length === 0) return null
  if (buckets.length > MAX_BUCKETS) return null

  const parts: string[] = []
  for (const bucket of buckets) {
    if (typeof bucket !== 'object' || bucket === null) return null
    const { prefix, total, addresses } = bucket as {
      prefix?: unknown
      total?: unknown
      addresses?: unknown
    }
    if (typeof prefix !== 'string' || prefix.length === 0) return null
    if (typeof total !== 'string' || !/^(0|[1-9][0-9]*)$/.test(total)) return null
    if (typeof addresses !== 'number' || !Number.isSafeInteger(addresses) || addresses < 0) {
      return null
    }
    // The prefix is a configured label like `deposit:`, so this class costs nothing legitimate and
    // removes every character that could reshape a log line or a console cell.
    const safe = prefix.replace(/[^A-Za-z0-9:._-]/g, '').slice(0, MAX_PREFIX)
    if (safe.length === 0) return null
    parts.push(`${safe} ${total} over ${addresses} address${addresses === 1 ? '' : 'es'}`)
  }
  return parts.join(', ')
}
