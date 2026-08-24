/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template. The parts that matter here — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent,
 * and a ledger is not the service in which to introduce a framework's opinions about body parsing.
 *
 * Three decisions in this file are load-bearing:
 *
 *   1. **Every domain route requires a *service* token.** A user token is refused even for reads.
 *      AD-06: "Reconciliation and audit need a service that no product can write to except through
 *      a typed posting API." `wallet` is what a user talks to; the ledger is what `wallet` talks
 *      to. Letting a browser reach this surface directly would make the scoped-token boundary
 *      decorative.
 *   2. **Amounts cross the wire as strings.** A JSON number is an IEEE 754 double, and an
 *      18-decimal EMBER amount silently loses its low bits in one. A number is accepted only when
 *      it is a safe integer, and the error otherwise says to send a string.
 *   3. **A bad token is 401; a verifier that could not reach the JWKS is 503.** Answering 401
 *      there would sign every service in the estate out because identity is having a bad minute.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { ForbiddenError, TokenError, bearerFrom, requireScope, statusFor, type Principal } from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { ENTRY_KINDS, isEntryKind } from '@cloudsforge/contracts-money'
import type { EntryKind, EntryMetadata, LedgerAssetCode } from '@cloudsforge/contracts-money'
import { AccountConflictError, UnknownAccountError, balancesForSubject } from './accounts.ts'
import {
  AccountNotPostableError,
  AlreadyReleasedError,
  AssetFrozenError,
  DEFAULT_PAGE_SIZE,
  InsufficientFundsError,
  LedgerValidationError,
  NotFoundError,
  RetiredAssetError,
  UnbalancedEntryError,
  type EntryView,
  type PostEntryDeps,
  type PostingRequest,
  listEntries,
  postEntry,
  readEntry,
  release,
  reserve,
  reverseEntryById,
  trialBalance,
} from './entries.ts'
import { IdempotencyInFlightError, IdempotencyKeyReuseError, requestFingerprint } from './idempotency.ts'
import { latestRuns, listFreezes } from './reconcile.ts'
import type { Db } from './outbox.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  /**
   * The per-network SELECTOR, not a handle. Routes use `ctx.sql`; `NetworkSql` has no query
   * methods, so reaching for the process-wide handle does not compile.
   */
  readonly sql: NetworkSql
  /**
   * The network to assume when no `CF-Network` arrives, or `undefined` to refuse. `CF_NETWORK_SINGLE`,
   * for `pnpm dev`, which has no gateway in front of it. Never set in production.
   */
  readonly singleNetwork?: Network
  readonly producer: string
  /** Refresh sampled gauges immediately before `/metrics` renders. */
  readonly beforeScrape?: () => Promise<void>
}

/**
 * The three scopes. Separate rather than one `ledger:write`, because posting money, reserving it
 * and reading it are three different authorities and a service that needs one rarely needs all
 * three: `market` reserves and reads, `wallet` posts and reads, a reporting job only reads.
 */
export const POST_SCOPE = 'ledger:post'
export const READ_SCOPE = 'ledger:read'
export const RESERVE_SCOPE = 'ledger:reserve'

/**
 * Domain metrics, declared rather than inferred from a log line — AD-20.
 *
 * `ledger_trial_balance_delta` is the one an alert fires on, and its threshold is not a
 * percentage: it must be **exactly zero**. Any other value means Σ debits ≠ Σ credits somewhere in
 * the journal, which should be unreachable while the deferred trigger exists.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'ledger_trial_balance_delta',
      help: 'Sum of |debits - credits| across every asset. MUST be 0; any other value is a P0.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'ledger_postings_total',
      help: 'Postings written, by originating service and entry kind',
      kind: 'counter',
      // This pair is what finally makes "how much did ForgeMint earn" answerable. Today
      // `ledger.source` is populated only by /internal/* routes, so per-product revenue is not
      // derivable from the estate at all.
      labels: ['service', 'kind'],
    })
    .register({
      name: 'ledger_entries_total',
      help: 'Journal entries committed',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'ledger_entries_replayed_total',
      help: 'Requests answered from a stored idempotent response rather than by posting',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'ledger_reconciliation_drift',
      help: 'Ledger custody total minus observed total, per asset. The sign carries the meaning. Only set when a run actually observed something — read it with ledger_reconciliation_observed.',
      kind: 'gauge',
      labels: ['asset'],
    })
    /**
     * **Read this BEFORE `ledger_reconciliation_drift`, or read that one wrong.**
     *
     * A gauge has no way to say "unknown": it holds its last value until something overwrites it.
     * So an asset whose runs stop observing anything keeps publishing whatever drift it last had —
     * and if that was 0, the dashboard shows a healthy zero forever while nobody is checking. That
     * is the same defect this release removed from the run row, one layer out, and it is why
     * `jobs.ts` sets 0 here and leaves the drift gauge untouched rather than writing
     * `Number(result.drift)` — `Number(null)` is `0`, which would have published the most
     * reassuring possible number for the least reassuring possible state.
     */
    .register({
      name: 'ledger_reconciliation_observed',
      help: '1 if the last reconciliation of this asset compared against a real observation, 0 if it had none. A 0 makes the drift gauge for that asset meaningless.',
      kind: 'gauge',
      labels: ['asset'],
    })
    /**
     * **The series that tells the two freezes apart, and the one whose absence let a defect hide.**
     *
     * `ledger_reconciliation_observed` going to 0 was the only signal an unobserved run produced,
     * and it fired identically for two states that need opposite responses: "Hearth has not
     * launched, so nothing can be observed" — expected, argued for in `env.ts`, and not a page —
     * and "this service's 600-second token expired inside a 900-second job", which is a page and
     * which the estate sat in for the life of the service. A counter labelled by reason is what
     * lets an alert fire on `no_credential` and `unauthorized` while staying quiet on
     * `indexer_error`.
     *
     * A counter rather than a gauge: the question is "how often, and has it started", not "what is
     * it now" — and unlike a gauge it does not hold a stale value once observation recovers.
     * Cardinality is bounded by `UnobservedReason`, which is a closed union of eight strings.
     */
    .register({
      name: 'ledger_reconciliation_unobserved_total',
      help: 'Reconciliation runs that observed nothing, by asset and by WHY. `no_credential` and `unauthorized` are faults in this platform, not in the chain.',
      kind: 'counter',
      labels: ['asset', 'reason'],
    })
    /**
     * Whether this process holds a service token it could present right now.
     *
     * The one number that would have made the ten-minute cliff visible from outside: it goes to 0
     * ten minutes after boot in a deployment that reads a token from a variable, and stays at 1 in
     * one that exchanges a credential. Sampled at scrape time from the provider's own snapshot —
     * see `index.ts`'s `beforeScrape` — never by dialling identity.
     */
    .register({
      name: 'ledger_service_token_usable',
      help: '1 if this replica holds a service token it can present to the indexer, 0 if it does not — including when no credential is configured',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'ledger_service_token_events_total',
      help: 'ServiceTokenProvider events: minted, exchange_failed, reminted_after_401, replay_skipped',
      kind: 'counter',
      labels: ['kind'],
    })
    .register({
      name: 'ledger_assets_frozen',
      help: 'Assets whose withdrawals are frozen by reconciliation drift',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'ledger_balance_rebuild_mismatches',
      help: 'Accounts where the balances projection disagrees with a journal replay. MUST be 0.',
      kind: 'gauge',
      labels: [],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 256 * 1024

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
  /**
   * The network THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * Not a property of the process: one pod serves both estates since the network consolidation
   * (micro-deploy `docs/network-consolidation.md`), so "which network am I" has no answer.
   */
  readonly network: Network
  /**
   * The database handle for `network`, resolved ONCE, at the edge of the request.
   *
   * Every route uses this rather than reaching for the process-wide handle, because a wrong handle
   * is not an error — it is a query that SUCCEEDS against the other estate's rows and says nothing.
   * `deps.sql` is a `NetworkSql` with no query methods, so the mistake does not compile.
   */
  readonly sql: Db
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff —
 * which is exactly what agora's first build did: 500 on every probe, container never ready.
 *
 * A literal SET rather than a prefix, because this is an exemption from a data boundary and
 * widening it should be a deliberate edit. Every member must answer without touching the database.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface Route {
  readonly method: string
  /** `/entries/:id/reverse`. Used verbatim as the metric label, so cardinality is bounded. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/entries/:id/reverse` into a matcher.
 *
 * The segment pattern excludes `/` so a parameter cannot swallow the rest of the path and make one
 * route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `(?<${segment.slice(1)}>[^/]+)` : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${source}$`)
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint unbounded
    // time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // ── THE NETWORK, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ──────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a cross-network write nothing would ever flag.
    //
    // The operational endpoints are exempt because kubelet and Prometheus do not come through the
    // gateway and never send the header. Refusing them makes the pod never become ready.
    const networkless = matched !== undefined && OPERATIONAL_ROUTES.has(matched.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? deps.sql.networks[0] ?? 'mainnet')
        : requestNetwork(req.headers, deps.singleNetwork ? { fallback: deps.singleNetwork } : {})
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(
        res,
        errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId),
        requestId,
      )
      finish(500, 'unknown')
      return
    }

    // ── RESOLVED INSIDE A TRY, AND THAT IS NOT DEFENSIVE PADDING ───────────────────────────────
    //
    // `deps.sql.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw escapes the `void` expression
    // past a `.catch` that is not attached yet, and the listener returns having sent NOTHING. The
    // connection then hangs until the client gives up: the one path the design most depends on
    // being loud was the one path that was silent.
    let sql: Db
    try {
      sql = deps.sql.for(network) as unknown as Db
    } catch (err) {
      log.error('no usable database handle for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }
    void handle(matched, { req, url, requestId, log, params, network, sql }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
      })
  })
}

/**
 * Map every failure onto a status.
 *
 * The ledger's errors are grouped by what the caller should do about them, which is the only
 * grouping that helps at the other end of the wire:
 *
 *   * **400** — the request could not be a legal entry. Fix the request; retrying will not help.
 *   * **404** — something named does not exist.
 *   * **409** — the request was well formed but the ledger's state refuses it: insufficient funds,
 *     a frozen asset, a key reused with a different body, a reservation already released. Retrying
 *     the same request unchanged will keep failing, but the caller may have a different next step.
 *   * **500** — an invariant fired that should have been unreachable from this code path. An
 *     `ImmutableError` here means something tried to rewrite history through the service, which is
 *     a bug in the service, not in the caller.
 */
async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }

    if (err instanceof LedgerValidationError) {
      return errorReply(400, 'invalid_entry', err.message, ctx.requestId, { problems: err.problems })
    }
    if (err instanceof UnbalancedEntryError) {
      // Reaching here means the database's deferred trigger refused an entry the application
      // thought was balanced. That is worth a loud log line: the two checks disagreeing is either
      // a bug in this service or a posting that arrived by another route.
      ctx.log.error('the deferred balancing trigger refused an entry', { err })
      return errorReply(400, 'unbalanced_entry', err.message, ctx.requestId)
    }
    if (err instanceof RetiredAssetError) {
      // Logged at warn, not info: every one of these is an unmigrated caller still trying to charge
      // in a wound-down unit, and the operator wants to know WHICH service before a customer does.
      ctx.log.warn('entry refused: retired asset', { asset: err.assetCode, kind: err.kind })
      return errorReply(400, 'retired_asset', err.message, ctx.requestId, { assetCode: err.assetCode })
    }
    if (err instanceof UnknownAccountError) {
      return errorReply(400, 'unknown_account', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (err instanceof InsufficientFundsError) {
      // `subject` and `purpose` travel as fields, so a caller can tell whose money ran out without
      // parsing English. micro-org#495: since the exchange desk is a non-exempt account, this one
      // status now covers both "the user does not have it" and "the platform does not have it",
      // and micro-wallet answers those two with different codes and different words. The message
      // stays as the trigger wrote it — it names the account and the resulting balance, which is
      // an operator's diagnosis and not something a caller forwards to a person.
      return errorReply(409, 'insufficient_funds', err.message, ctx.requestId, {
        ...(err.subject !== null ? { subject: err.subject } : {}),
        ...(err.purpose !== null ? { purpose: err.purpose } : {}),
      })
    }
    if (err instanceof AssetFrozenError) {
      ctx.log.warn('withdrawal refused: asset frozen', { asset: err.assetCode, reason: err.reason })
      return errorReply(409, 'asset_frozen', err.message, ctx.requestId, { assetCode: err.assetCode })
    }
    if (err instanceof AccountNotPostableError || err instanceof AccountConflictError) {
      return errorReply(409, 'account_conflict', err.message, ctx.requestId)
    }
    if (err instanceof AlreadyReleasedError) {
      return errorReply(409, 'already_released', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }

    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

/* ------------------------------------------------------------------------ routes */

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would lose
        // every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    define('POST', '/entries', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, POST_SCOPE)
      const body = await readJson(ctx.req)
      // The spread order is load-bearing: `attribute` wins over whatever the body said, and it has
      // already thrown 403 if the two disagree. Parsing first keeps the shape errors (400) ahead of
      // the attribution error (403), so a malformed body is never reported as an authority problem.
      const request = { ...parsePostEntry(body, ctx.requestId), ...attribute(principal, body) }

      const done = deps.lifecycle.track()
      try {
        const outcome = await postEntry(ledgerDeps(ctx.sql, deps), request, requestFingerprint(body))
        recordEntry(deps, outcome.result, outcome.replayed)
        ctx.log.info(outcome.replayed ? 'entry replayed' : 'entry posted', {
          entryId: outcome.result.id,
          kind: outcome.result.kind,
          originatingService: outcome.result.originatingService,
          replayed: outcome.replayed,
        })
        // 200 on a replay, 201 on a fresh post: the caller can tell whether its retry did the work
        // or merely found it done, without comparing bodies.
        return { status: outcome.replayed ? 200 : 201, body: { entry: outcome.result, replayed: outcome.replayed } }
      } finally {
        done()
      }
    }),

    define('GET', '/entries', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const limit = Number(ctx.url.searchParams.get('limit') ?? DEFAULT_PAGE_SIZE)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new LedgerValidationError('limit must be a positive integer')
      }
      const page = await listEntries(ctx.sql, {
        limit,
        ...optionalParam(ctx, 'cursor'),
        ...optionalParam(ctx, 'originatingService'),
        ...optionalParam(ctx, 'correlationId'),
        // Whose entries, rather than what kind of entry. Added for micro-org#495 §3 so a service
        // can read one user's conversions and transfers out of the journal instead of keeping a
        // second copy of them; see `ListEntriesQuery.subject` for why the absence forced a table.
        ...optionalParam(ctx, 'subject'),
        // Checked, not cast: `listEntries` would refuse an unknown kind anyway, but a filter is
        // the one place a caller TYPES a kind by hand, so it is where a typo is likeliest.
        ...(ctx.url.searchParams.get('kind')
          ? { kind: entryKindOrRefuse(ctx.url.searchParams.get('kind')!) }
          : {}),
      })
      return { status: 200, body: page }
    }),

    define('GET', '/entries/:id', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const entry = await readEntry(ctx.sql, ctx.params['id'] ?? '')
      if (!entry) throw new NotFoundError(`no entry ${ctx.params['id']}`)
      return { status: 200, body: { entry } }
    }),

    define('POST', '/entries/:id/reverse', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, POST_SCOPE)
      const body = await readJson(ctx.req)
      const { originatingService, actor } = attribute(principal, body)

      const done = deps.lifecycle.track()
      try {
        const outcome = await reverseEntryById(
          ledgerDeps(ctx.sql, deps),
          ctx.params['id'] ?? '',
          {
            originatingService,
            actor,
            correlationId: optionalString(body, 'correlationId') ?? ctx.requestId,
            idempotencyKey: requireString(body, 'idempotencyKey'),
            ...(optionalString(body, 'description') !== undefined
              ? { description: optionalString(body, 'description')! }
              : {}),
            ...(optionalEntryKind(body) !== undefined ? { kind: optionalEntryKind(body)! } : {}),
            ...(body['metadata'] !== undefined ? { metadata: body['metadata'] as EntryMetadata } : {}),
          },
          requestFingerprint(body),
        )
        recordEntry(deps, outcome.result, outcome.replayed)
        ctx.log.info('entry reversed', {
          reversalId: outcome.result.id,
          reversesEntryId: outcome.result.reversesEntryId,
          replayed: outcome.replayed,
        })
        return { status: outcome.replayed ? 200 : 201, body: { entry: outcome.result, replayed: outcome.replayed } }
      } finally {
        done()
      }
    }),

    define('POST', '/reservations', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, RESERVE_SCOPE)
      const body = await readJson(ctx.req)

      const done = deps.lifecycle.track()
      try {
        const outcome = await reserve(
          ledgerDeps(ctx.sql, deps),
          {
            subject: requireString(body, 'subject'),
            assetCode: requireString(body, 'assetCode') as LedgerAssetCode,
            amount: requireAmount(body, 'amount'),
            ...attribute(principal, body),
            correlationId: optionalString(body, 'correlationId') ?? ctx.requestId,
            idempotencyKey: requireString(body, 'idempotencyKey'),
            ...(optionalString(body, 'description') !== undefined
              ? { description: optionalString(body, 'description')! }
              : {}),
            ...(optionalEntryKind(body) !== undefined ? { kind: optionalEntryKind(body)! } : {}),
            ...(body['metadata'] !== undefined ? { metadata: body['metadata'] as EntryMetadata } : {}),
          },
          requestFingerprint(body),
        )
        recordEntry(deps, outcome.result, outcome.replayed)
        ctx.log.info('reservation made', { reservationId: outcome.result.id, replayed: outcome.replayed })
        return {
          status: outcome.replayed ? 200 : 201,
          // The reservation IS the entry: there is no separate reservations table to fall out of
          // step with the journal, so the id a caller holds onto is the entry id.
          body: { reservationId: outcome.result.id, entry: outcome.result, replayed: outcome.replayed },
        }
      } finally {
        done()
      }
    }),

    define('POST', '/reservations/:id/release', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, RESERVE_SCOPE)
      const body = await readJson(ctx.req)

      const done = deps.lifecycle.track()
      try {
        const outcome = await release(
          ledgerDeps(ctx.sql, deps),
          ctx.params['id'] ?? '',
          {
            ...attribute(principal, body),
            correlationId: optionalString(body, 'correlationId') ?? ctx.requestId,
            idempotencyKey: requireString(body, 'idempotencyKey'),
            ...(optionalString(body, 'description') !== undefined
              ? { description: optionalString(body, 'description')! }
              : {}),
            ...(body['metadata'] !== undefined ? { metadata: body['metadata'] as EntryMetadata } : {}),
          },
          requestFingerprint(body),
        )
        recordEntry(deps, outcome.result, outcome.replayed)
        ctx.log.info('reservation released', { entryId: outcome.result.id, replayed: outcome.replayed })
        return { status: outcome.replayed ? 200 : 201, body: { entry: outcome.result, replayed: outcome.replayed } }
      } finally {
        done()
      }
    }),

    define('GET', '/accounts/:subject/balances', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      // Decoded because a subject is `user:<uuid>` and the colon is percent-encoded by well-behaved
      // clients. `parseAccountSubject` inside the store rejects anything that is not a subject.
      const subject = decodeURIComponent(ctx.params['subject'] ?? '')
      try {
        const balances = await balancesForSubject(ctx.sql, subject)
        return { status: 200, body: { subject, balances } }
      } catch (err) {
        if (err instanceof RangeError) throw new LedgerValidationError(err.message)
        throw err
      }
    }),

    define('GET', '/trial-balance', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const result = await trialBalance(ctx.sql)
      deps.metrics.set('ledger_trial_balance_delta', Number(result.totalAbsoluteDelta))
      if (!result.balanced) {
        // There is no recoverable case here. Σ debits ≠ Σ credits means the deferred trigger is
        // gone or something wrote to `postings` outside this service, and every downstream number
        // is suspect until it is explained.
        ctx.log.fatal('TRIAL BALANCE IS NOT ZERO', { totalAbsoluteDelta: result.totalAbsoluteDelta })
      }
      // 200 either way: the caller asked what the trial balance is and this is the answer. A 500
      // here would deny a monitoring system the number it exists to read.
      return { status: 200, body: result }
    }),

    define('GET', '/reconciliation', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const [runs, freezes] = await Promise.all([latestRuns(ctx.sql), listFreezes(ctx.sql)])
      return { status: 200, body: { runs, freezes } }
    }),
  ]
}

/**
 * The posting bundle for ONE request, against that request's handle.
 *
 * Taken as an argument rather than read off `deps`, because `deps.sql` is now a selector with no
 * query methods — the compiler names every call site, which is exactly what is wanted in the
 * service where a wrong handle posts a double-entry to the other estate's books.
 */
function ledgerDeps(sql: Db, deps: ServerDeps): PostEntryDeps {
  return { sql, producer: deps.producer }
}

/** A replayed response created nothing, so it must not be counted as if it had. */
function recordEntry(deps: ServerDeps, entry: EntryView, replayed: boolean): void {
  if (replayed) {
    deps.metrics.increment('ledger_entries_replayed_total')
    return
  }
  deps.metrics.increment('ledger_entries_total')
  for (const _posting of entry.postings) {
    deps.metrics.increment('ledger_postings_total', {
      service: entry.originatingService,
      kind: entry.kind,
    })
  }
}

function optionalParam(ctx: RequestContext, name: string): Record<string, string> {
  const value = ctx.url.searchParams.get(name)
  return value ? { [name]: value } : {}
}

/* ------------------------------------------------------------------------ auth */

/**
 * Every domain route goes through here, and every one of them requires a **service** principal.
 *
 * A user token is refused with the same 403 as a service token missing the scope. That is not an
 * oversight: the ledger has no user-facing surface by design, and a route that quietly accepted a
 * user token would be a route through which a browser could read another subject's balances.
 */
async function authorise(ctx: RequestContext, deps: ServerDeps, scope: string): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  const principal = await deps.verifier.principal(token)
  if (principal.kind !== 'service') throw new ForbiddenError(`${scope} (service token required)`)
  requireScope(principal, scope)
  return principal
}

/**
 * Bind an entry's attribution to the caller that is actually making the request.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`originating_service` WAS A STRING IN THE REQUEST BODY, AND NOTHING EVER COMPARED IT WITH THE
 * TOKEN.** Every write route read it with `requireString(body, 'originatingService')` and wrote it
 * straight into the journal, so any holder of any `ledger:post` token could sign another service's
 * name to a movement of money. `actor` was the same field twice over.
 *
 * That is not a hypothetical. On 2026-08-04 a `deposit_credited` for 5000000000000000000 wei of
 * EMBER was posted against no on-chain deposit; the row read `originating_service = 'wallet'`,
 * `actor = 'service:wallet'`, and it was not wallet. `micro-wallet` posts to this service from
 * exactly five call sites (`money.ts`, `deposits.ts`, `withdrawals.ts/535/627`), every
 * one of them a real money operation, and it has no probe path at all. The incident response
 * nonetheless began by looking for one, because the journal said wallet and the journal was the
 * evidence. **A caller-supplied attribution is not evidence, and this service publishes it as
 * though it were** — `ledger_postings_total{service,kind}` is labelled from it and its own comment
 * calls it the thing that finally makes "how much did ForgeMint earn" answerable, and
 * `GET /entries?originatingService=` is an audit query over it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why this refuses rather than silently stamping the right name
 *
 * Deriving `originatingService` from the principal and ignoring the body would also make the column
 * true, and it was the first thing tried. It is worse: a caller that believes it is posting as
 * another service would have its entry quietly relabelled and would never find out, which is the
 * class of "fixed by making the check unable to fail" this repository keeps deleting. The field
 * stays REQUIRED — the caller states who it thinks it is — and a disagreement is a 403.
 *
 * ## Why `actor` is bound only when it names a service
 *
 * `actor` is a wider vocabulary than `originatingService`: `system` is the honest actor for a
 * scheduled sweep and `user:<id>` for an operator acting through a service. Only the
 * `service:<name>` form is a claim about *which service*, so only that form is checked. Binding
 * `system` to `service:<caller>` would force a lie into every job-driven entry in the estate.
 *
 * ## What this does NOT do, stated so nobody mistakes it for a solvency control
 *
 * It does not make an unbacked credit impossible. A caller holding wallet's own credential can
 * still post one, and the only thing in the estate that catches that is reconciliation against the
 * chain — which is why nothing here is allowed to exempt anything from that check. This makes the
 * journal's answer to *who did it* trustworthy. Reconciliation remains the answer to *is it real*.
 */
function attribute(
  principal: Principal,
  body: Record<string, unknown>,
): { originatingService: string; actor: `service:${string}` } {
  const originatingService = requireString(body, 'originatingService')
  const actor = requireString(body, 'actor')
  // Narrowed by `authorise`, which refuses every non-service principal before this is reached.
  const caller = principal.kind === 'service' ? principal.service : ''

  if (originatingService !== caller) {
    throw new ForbiddenError(
      `attribution to '${originatingService}' (this token was minted for '${caller}')`,
    )
  }
  if (actor.startsWith('service:') && actor !== `service:${caller}`) {
    throw new ForbiddenError(
      `actor '${actor}' (this token was minted for '${caller}')`,
    )
  }
  return { originatingService, actor: actor as `service:${string}` }
}

/* ------------------------------------------------------------------------ body parsing */

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any authenticated caller could otherwise reach.
    if (size > MAX_BODY_BYTES) throw new LedgerValidationError('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new LedgerValidationError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof LedgerValidationError) throw err
    throw new LedgerValidationError('request body is not valid JSON')
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LedgerValidationError(`${field} is required and must be a non-empty string`)
  }
  return value.trim()
}

/**
 * The entry kind, CHECKED rather than asserted — micro-org#424.
 *
 * This was `requireString(body, 'kind') as EntryKind`, which is a promise to the compiler about a
 * value that arrived over the wire. It was not a live defect, because `validateEntryRequest` runs
 * `isEntryKind` a moment later, but it is the wrong shape for the one place in the estate that owns
 * the vocabulary: a cast here means the type says "checked" everywhere downstream on the strength
 * of nothing, and the day someone reorders the parse and the validation it becomes real.
 *
 * The error it raises is also better than the generic one. Two services have shipped an invented
 * kind — foresight's `foresight.settlement_fee` and tessera's `item_issue` (micro-org#407 §3) — and
 * in both cases the author's next question was "then what ARE the kinds?". The answer is now in the
 * 400, which is where the person reading it already is.
 */
function requireEntryKind(body: Record<string, unknown>): EntryKind {
  return entryKindOrRefuse(requireString(body, 'kind'))
}

/**
 * The kind on a REVERSAL, which is optional and was the one that could still reach the database.
 *
 * `POST /entries/:id/reverse` lets the caller name the kind of the correcting entry, and that value
 * was cast, passed to `reverseEntry`, and inserted. Nothing on the path ran `isEntryKind`:
 * `validateEntryRequest` is for `POST /entries` and never sees a reversal. So an invented kind here
 * did not get the ledger's 400 — it got as far as `journal_entries_kind_chk` and came back as a
 * database exception, which is a 500 the operator has to read postgres logs to explain.
 *
 * Same check, same message, one route earlier.
 */
function optionalEntryKind(body: Record<string, unknown>): EntryKind | undefined {
  const kind = optionalString(body, 'kind')
  return kind === undefined ? undefined : entryKindOrRefuse(kind)
}

function entryKindOrRefuse(kind: string): EntryKind {
  if (!isEntryKind(kind)) {
    throw new LedgerValidationError(
      `unknown entry kind: ${kind} — the vocabulary is closed, and is: ${ENTRY_KINDS.join(', ')}`,
    )
  }
  return kind
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new LedgerValidationError(`${field} must be a string`)
  return value
}

/**
 * Read a money amount.
 *
 * A string is the expected form and is parsed with `BigInt`, exactly. A JSON number is accepted
 * only when it is already a safe integer — beyond that the value in the request has *already* lost
 * precision before this code ran, so the honest answer is to refuse it and say why rather than to
 * store a number that is quietly not the one the caller meant.
 */
function requireAmount(body: Record<string, unknown>, field: string): bigint {
  const value = body[field]
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new LedgerValidationError(
        `${field} is not an exact integer as a JSON number; send it as a decimal string`,
      )
    }
    return BigInt(value)
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    throw new LedgerValidationError(`${field} must be an integer in smallest units, as a string`)
  }
  return BigInt(value.trim())
}

/** Parse `POST /entries`. Everything it rejects is something the database would reject later. */
export function parsePostEntry(body: Record<string, unknown>, fallbackCorrelationId: string) {
  const rawPostings = body['postings']
  if (!Array.isArray(rawPostings) || rawPostings.length === 0) {
    throw new LedgerValidationError('postings must be a non-empty array')
  }

  const postings: PostingRequest[] = rawPostings.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new LedgerValidationError(`posting ${index} must be an object`)
    }
    const posting = raw as Record<string, unknown>
    const direction = posting['direction']
    if (direction !== 'debit' && direction !== 'credit') {
      throw new LedgerValidationError(`posting ${index} direction must be 'debit' or 'credit'`)
    }
    const sequence = posting['sequence'] ?? index
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
      throw new LedgerValidationError(`posting ${index} sequence must be a non-negative integer`)
    }

    const account = posting['account'] as Record<string, unknown> | undefined
    return {
      direction,
      amount: requireAmount(posting, 'amount'),
      assetCode: requireString(posting, 'assetCode') as LedgerAssetCode,
      sequence,
      ...(typeof posting['accountId'] === 'string' ? { accountId: posting['accountId'] } : {}),
      ...(account
        ? {
            account: {
              subject: requireString(account, 'subject') as never,
              assetCode: requireString(account, 'assetCode') as LedgerAssetCode,
              purpose: requireString(account, 'purpose') as never,
              type: requireString(account, 'type') as never,
              ...(account['overdraftAllowed'] === true ? { overdraftAllowed: true } : {}),
            },
          }
        : {}),
    } satisfies PostingRequest
  })

  return {
    kind: requireEntryKind(body),
    originatingService: requireString(body, 'originatingService'),
    actor: requireString(body, 'actor') as `service:${string}`,
    correlationId: optionalString(body, 'correlationId') ?? fallbackCorrelationId,
    idempotencyKey: requireString(body, 'idempotencyKey'),
    postings,
    ...(optionalString(body, 'description') !== undefined
      ? { description: optionalString(body, 'description')! }
      : {}),
    ...(optionalString(body, 'occurredAt') !== undefined
      ? { occurredAt: optionalString(body, 'occurredAt')! }
      : {}),
    ...(optionalString(body, 'reversesEntryId') !== undefined
      ? { reversesEntryId: optionalString(body, 'reversesEntryId')! }
      : {}),
    ...(body['metadata'] !== undefined ? { metadata: body['metadata'] as EntryMetadata } : {}),
  }
}

/* ------------------------------------------------------------------------ replies */

function errorReply(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra: Record<string, unknown> = {},
): Reply {
  return { status, body: { error: { code, message, requestId, ...extra } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health, metrics and balance answers are a point-in-time fact. A cached 200 from a replica
    // that has since gone unready is exactly the lie this arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
