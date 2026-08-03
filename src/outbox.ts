/**
 * Outbox, relay and inbox.
 *
 * Rule 5 of docs/ecosystem/03 §2: every state change others care about writes an outbox row **in
 * the same transaction as the change**. That single word is the whole design. A publish after
 * commit is a publish that is skipped when the process dies in between, and a publish before
 * commit is a publish of something that never happened; both failure modes are silent and both
 * are unrecoverable after the fact. Writing the event with the change makes the outbox row and
 * the domain row succeed or fail together, and turns delivery into a retry problem, which is a
 * problem with a solution.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won. Consumers
 * dedupe on `(topic, event_id)` — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`, and AD-10 records the four
 * measured conditions under which that stops being true.
 */

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPIC_HEADER,
  signDelivery,
  validateEnvelope,
  verifyDelivery,
  type EventVersion,
} from '@cloudsforge/contracts-events'
import type { Sql, TransactionSql } from 'postgres'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'

export type Db = Sql
export type Tx = TransactionSql

/** What a caller emits. The envelope's `id`, `occurredAt` and `producer` are added here. */
export interface DomainEvent {
  /** `<service>.<aggregate>.<past-tense-verb>` — `widget.widget.created`. */
  readonly topic: string
  /** Ordering is per `(topic, key)` only. Choose the aggregate id, never a timestamp. */
  readonly key: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly correlationId?: string
  readonly version?: number
}

/**
 * The wire version, in the CONTRACT's shape.
 *
 * `@cloudsforge/contracts-events` types `EventEnvelope.version` as `${number}.${number}` — a
 * "major.minor" STRING — and its consumers refuse an envelope without one ("version: missing").
 * Every producer typed it `number` end to end and sent `1`, so even a delivery whose signature
 * verified was refused at the envelope. The stored column stays an integer — storage records the
 * major — and the mapping to the contract's shape happens here, at the wire, in one place.
 */
const wireVersion = (v: number): EventVersion => `${v}.0`

/**
 * The wire envelope is `@cloudsforge/contracts-events`' — re-exported, not redeclared.
 *
 * The local copy that used to sit here typed `actor` and `correlationId` as `string | null` and let
 * the nullable COLUMNS through untouched. The contract requires an `Actor` and a non-null
 * `correlationId` and refuses both nulls, so any event emitted without them was unreadable by every
 * consumer in the estate. `ledger.entry.posted` happened to survive that because a posting always
 * carries a request's actor and correlation id; `ledger.reconciliation.completed` has neither — it
 * is a leased job woken by a schedule — so the very first thing this service emits from a job would
 * have been refused at the envelope. See `buildEnvelope`.
 */
export type { EventEnvelope } from '@cloudsforge/contracts-events'
import type { EventEnvelope } from '@cloudsforge/contracts-events'

export type Emit = (event: DomainEvent) => void

/**
 * Run a domain change and its events in one transaction.
 *
 *   const widget = await withOutbox(sql, SERVICE, async (tx, emit) => {
 *     const row = await insertWidget(tx, input)
 *     emit({ topic: 'widget.widget.created', key: row.id, payload: { id: row.id } })
 *     return row
 *   })
 *
 * `emit` collects rather than writes, so the events land after the handler has succeeded and a
 * caller cannot accidentally publish an event for a change it then rolled back.
 */
export async function withOutbox<T>(
  sql: Db,
  producer: string,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
): Promise<T> {
  const outcome = await sql.begin(async (tx) => {
    const pending: DomainEvent[] = []
    const value = await fn(tx, (event) => {
      pending.push(event)
    })
    for (const event of pending) {
      await tx`
        insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
        values (
          ${event.topic},
          ${event.key},
          ${producer},
          ${event.version ?? 1},
          ${event.actor ?? null},
          ${event.correlationId ?? null},
          ${tx.json(event.payload as Record<string, never>)}
        )
      `
    }
    // Wrapped so postgres.js does not treat an array-shaped result as a list of promises to
    // unwrap, which would rewrite the caller's return type.
    return { value }
  })
  return outcome.value
}

/* ------------------------------------------------------------------------ signing */


/** `sha256=<hex>` over the exact bytes sent, so a subscriber verifies before parsing. */
/**
 * THE CONTRACT SIGNS, NOT THIS FILE. This used to be a local implementation — `sha256=<hmac over
 * the body>` under a locally-declared header name — and four other producers carried the same
 * copy. The contract (`@cloudsforge/contracts-events`) signs `t=<seconds>,v1=<hmac over
 * "<seconds>.<body>">` under `cf-signature`, and the consumers that import it (activity, notify)
 * verify exactly that: every delivery from every producer was refused, first as
 * "signature: missing" and, once the header name was aligned, as "malformed_header". Two drifted
 * copies of one contract value, found the first time the bus was composed for real.
 *
 * The exported names stay, so no call site or test changes; the implementations are the
 * contract's, so they cannot drift again.
 */
export function signEvent(body: string, secret: string): string {
  return signDelivery(body, secret)
}

/** Timing-safety and the freshness window both live in the contract's verifier. */
export function verifyEventSignature(body: string, secret: string, presented: string): boolean {
  return verifyDelivery(body, presented, secret).ok
}

/* ------------------------------------------------------------------------ relay */

/**
 * The envelope as this file can prove it at COMPILE time, before the classifier looks at it.
 *
 * `version` is the contract's `EventVersion`, so `version: row.version` — the stored integer, which
 * is exactly what `market`, `trade`, `community` and `devplatform` all shipped — is a type error
 * rather than a test failure. `actor` and `correlationId` are non-nullable `string`, so the nullable
 * columns cannot be passed through without a decision being made about them here.
 *
 * `topic` and `producer` stay `string`: they are a `TopicName` and a `ProducerService` on the wire
 * but free text in the table, and a cast asserting them would be the producer vouching for itself.
 * Those are checked at run time by the contract's own validator.
 */
interface EnvelopeCandidate {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurredAt: string
  readonly producer: string
  readonly version: EventVersion
  readonly actor: string
  readonly correlationId: string
  readonly payload: Record<string, unknown>
}

/**
 * An outbox row, as the contract's envelope — or the reasons it is not one.
 *
 * The stored row is looser than the wire: `actor` and `correlation_id` are nullable columns and
 * `topic` and `producer` are free text, while `EventEnvelope` requires an `Actor`, a non-null
 * `correlationId`, a registered `TopicName` and a known `ProducerService`. Rather than cast that gap
 * away, this builds the envelope and hands it to the CONTRACT'S OWN `validateEnvelope`, so the
 * relay's idea of a valid event and a subscriber's are the same function.
 *
 * `validateEnvelope` rather than `classifyEnvelope` here, and that is a fact about this service
 * rather than a preference: **both** topics it emits are in the registry
 * (`ledger.entry.posted` and `ledger.reconciliation.completed`), so an unregistered topic on this
 * bus is a defect and not a lagging release. `src/topics.ts` asserts that in both directions, and
 * carries the quarantine machinery for the day this service invents a third.
 *
 * `system` for a missing actor is the contract's own value for "no principal did this" — a
 * scheduled reconciliation — which is exactly what a null actor column means here. A missing
 * correlation id falls back to the event id: an id that ties the event to itself is weaker than one
 * that ties it to the request, but it is never absent, and an absent one is where a cross-service
 * investigation stops.
 */
export function buildEnvelope(
  row: OutboxRow,
): { ok: true; value: EventEnvelope } | { ok: false; defects: readonly string[] } {
  const candidate: EnvelopeCandidate = {
    id: row.id,
    topic: row.topic,
    key: row.key,
    occurredAt: row.occurred_at.toISOString(),
    producer: row.producer,
    version: wireVersion(row.version),
    actor: row.actor ?? 'system',
    correlationId: row.correlation_id ?? row.id,
    payload: row.payload,
  }
  const verdict = validateEnvelope(candidate)
  return verdict.ok ? { ok: true, value: verdict.value } : { ok: false, defects: verdict.errors }
}

export interface RelayDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly signingSecret: string
  readonly batchSize?: number
  readonly deadlineMs?: number
  /** Test seam. Production builds one `HttpClient` per subscription URL. */
  readonly clientFor?: (url: string) => Pick<HttpClient, 'request'>
}

export interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

interface SubscriptionRow {
  readonly id: string
  readonly url: string
}

/**
 * The relay job.
 *
 * A leased job rather than a `setInterval`, for the reason rule 8 exists: two replicas running an
 * interval-driven relay both read the same unpublished rows and every subscriber receives every
 * event twice. The lease key names the contended resource — the outbox stream — so exactly one
 * replica relays at a time whatever the replica count is.
 */
export function createRelay(deps: RelayDeps): Handler {
  const batchSize = deps.batchSize ?? 50
  const deadlineMs = deps.deadlineMs ?? 5_000
  // Clients are cached for the life of the process so a circuit breaker accumulates state across
  // ticks. A fresh client per tick has a permanently closed circuit and hammers a dead subscriber.
  const clients = new Map<string, Pick<HttpClient, 'request'>>()
  const clientFor =
    deps.clientFor ??
    ((url: string) => {
      const existing = clients.get(url)
      if (existing) return existing
      const parsed = new URL(url)
      const client = new HttpClient({ baseUrl: parsed.origin, name: `subscriber:${parsed.host}` })
      clients.set(url, client)
      return client
    })

  return async (_job, ctx) => {
    const events = await deps.sql<OutboxRow[]>`
      select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
        from outbox
       where published_at is null
       order by occurred_at
       limit ${batchSize}
    `

    for (const event of events) {
      if (ctx.signal.aborted) return

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      const built = buildEnvelope(event)
      if (!built.ok) {
        // REFUSED HERE RATHER THAN SENT. An envelope the contract rejects is one every subscriber
        // rejects, so relaying it burns a retry budget delivering something nobody can accept —
        // and `market`, `trade`, `community` and `devplatform` all shipped exactly that for weeks
        // without noticing, because their suites verified against their own fake buses.
        //
        // Logged and SKIPPED, not published: the row stays unpublished so the defect is visible in
        // the backlog and is delivered once whatever produced it is fixed, rather than being
        // silently marked done.
        deps.logger.error('outbox row is not a valid envelope; not relayed', {
          eventId: event.id,
          topic: event.topic,
          defects: built.defects,
        })
        continue
      }
      const envelope = built.value
      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signEvent(JSON.stringify(envelope), deps.signingSecret)

      for (const subscription of subscriptions) {
        await deliver(deps, clientFor, subscription, envelope, signature, deadlineMs)
      }

      // Only when nothing is outstanding.
      //
      // THE GUARANTEE THIS USED TO CLAIM IS FALSE, and it was carried verbatim by eighteen
      // repositories. It said "a subscriber added after the event was written still receives it",
      // which holds only while some OTHER subscriber is still undelivered. With no active
      // subscription for the topic — the ordinary case for a new event type — the count below is
      // zero on the first pass, the row is published immediately, and it is never reconsidered. A
      // subscriber added afterwards gets nothing.
      //
      // The behaviour is right: an outbox row that stays unpublished because nobody is listening
      // is a backlog that grows for ever. It is the promise that was wrong, and a false guarantee
      // is worse than none, because an integrator plans around it — "register the subscription
      // whenever, the outbox will catch up" is a reasonable thing to believe from the old wording
      // and will silently lose every event published before the subscription existed.
      //
      // Delivery rows ARE computed from the live subscription set on every pass, which is what
      // makes a subscriber added mid-flight receive the remainder. That is the true half.
      const outstanding = await deps.sql<{ n: number }[]>`
        select count(*)::int as n
          from event_subscriptions s
          left join outbox_deliveries d
            on d.subscription_id = s.id and d.event_id = ${event.id}
         where s.topic = ${event.topic}
           and s.active = true
           and d.delivered_at is null
      `
      if ((outstanding[0]?.n ?? 0) === 0) {
        await deps.sql`update outbox set published_at = now() where id = ${event.id}`
      }

      // A long backlog must not outlive the lease and hand the same events to a second replica.
      await ctx.heartbeat()
    }
  }
}

async function deliver(
  deps: RelayDeps,
  clientFor: (url: string) => Pick<HttpClient, 'request'>,
  subscription: SubscriptionRow,
  envelope: EventEnvelope,
  signature: string,
  deadlineMs: number,
): Promise<boolean> {
  const claimed = await deps.sql<{ delivered_at: Date | null }[]>`
    insert into outbox_deliveries (event_id, subscription_id, attempts)
    values (${envelope.id}, ${subscription.id}, 0)
    on conflict (event_id, subscription_id) do update set attempts = outbox_deliveries.attempts + 1
    returning delivered_at
  `
  if (claimed[0]?.delivered_at) return true

  const parsed = new URL(subscription.url)
  try {
    await clientFor(subscription.url).request(`${parsed.pathname}${parsed.search}`, {
      method: 'POST',
      body: envelope,
      deadlineMs,
      // The event id is the idempotency key, which is what makes this POST safe to retry and is
      // the same value the subscriber dedupes on.
      idempotencyKey: envelope.id,
      headers: {
        [SIGNATURE_HEADER]: signature,
        [EVENT_ID_HEADER]: envelope.id,
        [TOPIC_HEADER]: envelope.topic,
      },
      ...(envelope.correlationId ? { requestId: envelope.correlationId } : {}),
    })
    await deps.sql`
      update outbox_deliveries set delivered_at = now(), last_error = null
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.sql`
      update outbox_deliveries set last_error = ${message.slice(0, 2_000)}
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    // Logged, not thrown: one unreachable subscriber must not stop the other subscribers or the
    // rest of the batch. The job succeeds; the undelivered row is the durable record, and the
    // next pass retries it.
    deps.logger.warn('event delivery failed', {
      topic: envelope.topic,
      eventId: envelope.id,
      subscriptionId: subscription.id,
      err: message,
    })
    return false
  }
}

/* ------------------------------------------------------------------------ inbox */

export type InboxOutcome<T> = { readonly status: 'processed'; readonly value: T } | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * The insert and the handler share one transaction, so a handler that fails leaves no inbox row
 * and the redelivery is processed rather than swallowed — which is the mistake that makes a naive
 * "record then handle" dedupe lose events.
 */
export async function withInbox<T>(
  sql: Db,
  topic: string,
  eventId: string,
  handle: (tx: Tx) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}

export { EVENT_ID_HEADER, SIGNATURE_HEADER, TOPIC_HEADER }
