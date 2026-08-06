/**
 * The one peer this service calls, and the credential it presents to it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE FIFTEEN-MINUTE JOB AND THE TEN-MINUTE TOKEN
 *
 * `LEDGER_SERVICE_TOKEN` held a token that lives **600 seconds** (`identity/src/tokens.ts`).
 * The reconciliation job runs every **900 seconds** (`jobs.ts:recurringJobs`). The composition root
 * read the variable once, at import:
 *
 *     token: () => env.indexerToken            // index.ts, for the life of the service
 *
 * so the chain half of the solvency invariant authenticated **exactly once per bootstrap** — at
 * boot, before the first sweep — and never again. Every sweep from minute ten onwards presented a
 * dead token, got a 401, mapped it to no observation, recorded `unavailable` / `failed` and froze
 * EMBER.
 *
 * **And that freeze was byte-identical to the honest one.** This service is designed to freeze a
 * chain asset nobody can observe, and until Hearth's mainnet launches that is EMBER's correct
 * state. So the guarantee built to stop the ledger lying to itself was reporting a true-shaped fact
 * for a false reason, in a row, a log line and an event that an operator could not tell apart from
 * the right one. `env.ts` on `identityCredential` carries the argument in full.
 *
 * The seam was already right. `token` was a function called per request precisely so "a future
 * short-TTL credential needs no change here". It just never had a body that could mint anything —
 * minting required the `admin` role. Identity now exchanges a long-lived credential for a token on
 * demand, and `@cloudsforge/auth`'s `ServiceTokenProvider` is the thing that does the exchanging:
 * it re-mints at ~80% of `expiresIn` jittered per token, shares one in-flight exchange between
 * concurrent callers, and on a 401 discards exactly the rejected token and replays once.
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts`
 *
 * Because the defect is a WIRING defect, and wiring that lives in the composition root is wiring no
 * test can reach — `index.ts` opens a pool, asserts a schema, starts a job runner and calls
 * `listen()`, so importing it from a test starts a server. wallet learned this the same way and for
 * the same reason (`wallet/src/upstreams.ts`): a suite full of tests that build their own clients
 * cannot catch a composition root that builds a different one. A test that constructs its own
 * provider proves the provider works. Only a test that goes through `buildUpstreams` proves this
 * service uses it, and `servicetoken.test.ts` beside this file does exactly that — reverting the
 * body below to `() => env.indexerToken` turns it red.
 *
 * ## BOTH HOOKS, AND THE SECOND IS NOT DECORATION
 *
 * `token` keeps the credential fresh on a schedule computed from this process's clock. `fetch`
 * catches a 401 from the indexer, re-mints and replays once. Without the second, correctness would
 * depend on this process and the indexer agreeing about what time it is — and on a fifteen-minute
 * job that is one skewed clock away from being back where it started.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  ServiceTokenProvider,
  ServiceTokenUnavailableError,
  type ProviderEvent,
} from '@cloudsforge/auth'
import type { ResultEvent } from '@cloudsforge/http'
import { httpIndexerClient, type IndexerClient } from './indexerclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That is
// the same "untestable therefore unchecked" property that let the cliff survive.
import type { Env } from './env.ts'

export interface Upstreams {
  /**
   * `null` when no credential is configured.
   *
   * **Deliberately NOT wired to a hard readiness probe**, which is where this service parts company
   * with wallet's otherwise-identical adoption. wallet does everything across a service boundary,
   * so a wallet with no credential can serve almost nothing and `serviceTokenProbe` correctly takes
   * it out of the balancer. The ledger is the opposite shape: every inbound route it serves —
   * posting entries, reading balances, reserving — needs no outbound call at all. Exactly one
   * background job does, and its failure already has a consequence that is stronger than a probe
   * and impossible to miss, because it stops withdrawals for the asset.
   *
   * Failing `/readyz` here would remove the service that serves every balance in the estate from
   * its balancer over a variable that only affects a fifteen-minute sweep. That trade is the one
   * `env.ts` refuses when it declines to make the credential `requiredSecret`, and making it here
   * instead would be the same mistake one layer out. The absence is reported at boot by `index.ts`,
   * as a gauge on every scrape, and in the run row as `unobserved_reason = 'no_credential'`.
   */
  readonly identityTokens: ServiceTokenProvider | null
  /**
   * `undefined` when `INDEXER_URL` is unset — which is not a disabled check but a failing one, and
   * is why the variable can be absent at all (`ledger-migrate` shares this environment). See
   * `env.ts` on `indexerUrl`.
   */
  readonly indexer: IndexerClient | undefined
}

export interface UpstreamOptions {
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
  readonly onResult?: ((event: ResultEvent) => void) | undefined
}

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  'identityUrl' | 'identityCredential' | 'indexerUrl' | 'indexerDeadlineMs'
>

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions = {}): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        // Not narrowed. Identity issues the service's whole allowlist, which for `ledger` is the
        // single scope `INDEXER_SCOPES` declares, so narrowing would restate a list that
        // `derive-grants.mjs` already derives from the source of truth — and a narrowing that
        // drifted would 403 with nothing in either log naming the cause.
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  /**
   * What the indexer client asks for the `Authorization` header.
   *
   * **Rejects rather than resolving `undefined` when there is no credential.** `HttpClient` omits
   * the header entirely for `undefined`, so the request would go out unauthenticated, come back
   * 401, and be recorded as `unauthorized` — telling an operator that the indexer refused the
   * ledger's token when the truth is that nobody gave the ledger a credential. Those are different
   * mornings, and keeping them different is the entire point of this change.
   */
  const token = (): Promise<string> =>
    identityTokens
      ? identityTokens.token()
      : Promise.reject(
          new ServiceTokenUnavailableError('no identity credential is configured; see LEDGER_IDENTITY_CREDENTIAL'),
        )

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // indexer client gets, and it is the layer where a 401 is visible and where the header was set.
  const peerFetch = identityTokens?.authorizedFetch ?? options.fetch

  return {
    identityTokens,
    indexer: env.indexerUrl
      ? httpIndexerClient({
          baseUrl: env.indexerUrl,
          token,
          deadlineMs: env.indexerDeadlineMs,
          ...(peerFetch ? { fetch: peerFetch } : {}),
          ...(options.onResult ? { onResult: options.onResult } : {}),
        })
      : undefined,
  }
}
