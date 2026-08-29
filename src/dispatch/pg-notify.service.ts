import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';

/** Reconnect backoff bounds, in milliseconds. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * How many distinct payloads a debounce window keeps before it stops recording
 * them. Past this the wake is still delivered, just without the payload list —
 * every consumer is required to be able to drain without one anyway.
 */
const MAX_BUFFERED_PAYLOADS = 1_000;

export interface NotifySubscription {
    /** Postgres channel name, unquoted. */
    channel: string;
    /**
     * Coalescing window. A burst of notifications inside it produces exactly one
     * wake — which is the whole point: a 500-package import fires 500 NOTIFYs for
     * a handful of shifts.
     */
    debounceMs: number;
    /**
     * Called once per window with the distinct payloads seen, and once with an
     * empty array immediately after every (re)connect. An empty array means
     * "drain everything you can find", so a consumer must never treat the
     * payload list as the complete work set.
     */
    onWake: (payloads: string[]) => Promise<void> | void;
}

/**
 * LISTEN/NOTIFY on a connection of its own.
 *
 * A DEDICATED pg.Client, never a pooled connection. A pool is free to hand the
 * underlying socket to an unrelated query, or to close and replace it, and the
 * LISTEN registration goes with it — silently. Nothing errors; notifications
 * simply stop arriving, and the only symptom is that shifts quietly stop being
 * re-optimised.
 *
 * On every reconnect the channels are re-LISTENed AND every subscriber is woken
 * immediately, because notifications fired while the socket was down were
 * delivered to nobody. That wake is what turns a dropped connection into a few
 * seconds of latency instead of work lost until the next unrelated event.
 */
@Injectable()
export class PgNotifyService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(PgNotifyService.name);
    private readonly subscriptions = new Map<string, NotifySubscription>();
    private readonly buffers = new Map<string, Set<string>>();
    private readonly timers = new Map<string, NodeJS.Timeout>();

    private client: Client | null = null;
    private reconnectDelayMs = RECONNECT_MIN_MS;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    /**
     * Registers a channel. Safe to call before or after the connection is up:
     * subscriptions added later are LISTENed immediately if a client exists, and
     * picked up by the next connect otherwise.
     */
    subscribe(subscription: NotifySubscription): void {
        this.subscriptions.set(subscription.channel, subscription);
        if (this.client) {
            void this.listenOn(this.client, subscription.channel);
        }
    }

    async onApplicationBootstrap(): Promise<void> {
        if (!process.env.DB_URL) {
            this.logger.warn(
                'DB_URL is not set — LISTEN/NOTIFY is disabled. Consumers fall back to their own sweeps.',
            );
            return;
        }
        await this.connect();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();

        const client = this.client;
        this.client = null;
        if (client) {
            await client.end().catch(() => undefined);
        }
    }

    /** True while a live listening connection is up. Exposed for health checks. */
    isConnected(): boolean {
        return this.client !== null;
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;

        const client = new Client({ connectionString: process.env.DB_URL });

        // Attached before connect(): a socket error during the handshake is
        // still an error event on this client, and an unhandled one takes the
        // process down.
        client.on('error', (err: Error) => {
            this.logger.warn(`Notification connection error: ${err.message}`);
            this.handleDrop(client);
        });
        client.on('end', () => this.handleDrop(client));

        try {
            await client.connect();
        } catch (err: unknown) {
            this.logger.warn(`Notification connection failed: ${String(err)}`);
            this.scheduleReconnect();
            return;
        }

        client.on('notification', (msg) => {
            this.onNotification(msg.channel, msg.payload ?? '');
        });

        this.client = client;
        this.reconnectDelayMs = RECONNECT_MIN_MS;

        for (const channel of this.subscriptions.keys()) {
            await this.listenOn(client, channel);
        }

        this.logger.log(
            `Listening on ${[...this.subscriptions.keys()].join(', ') || '(no channels yet)'}.`,
        );

        // Drain immediately. Anything that happened while this connection was
        // being established notified nobody.
        for (const subscription of this.subscriptions.values()) {
            void this.fire(subscription, []);
        }
    }

    private async listenOn(client: Client, channel: string): Promise<void> {
        try {
            // Channel names come from module constants, never from user input;
            // quoting them keeps a name with a capital or a hyphen working.
            await client.query(`LISTEN "${channel}"`);
        } catch (err: unknown) {
            this.logger.warn(`LISTEN ${channel} failed: ${String(err)}`);
        }
    }

    private handleDrop(client: Client): void {
        if (this.client !== client) return; // already replaced
        this.client = null;
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) return;
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
        // Never hold the event loop open for a reconnect.
        this.reconnectTimer.unref?.();
    }

    private onNotification(channel: string, payload: string): void {
        const subscription = this.subscriptions.get(channel);
        if (!subscription) return;

        let buffer = this.buffers.get(channel);
        if (!buffer) {
            buffer = new Set<string>();
            this.buffers.set(channel, buffer);
        }
        if (payload && buffer.size < MAX_BUFFERED_PAYLOADS) buffer.add(payload);

        // Leading-edge suppression, trailing-edge delivery: the first
        // notification starts the window and the wake happens when it closes, so
        // a burst produces one wake rather than one per notification.
        if (this.timers.has(channel)) return;

        const timer = setTimeout(() => {
            this.timers.delete(channel);
            const payloads = [...(this.buffers.get(channel) ?? [])];
            this.buffers.delete(channel);
            void this.fire(subscription, payloads);
        }, subscription.debounceMs);
        timer.unref?.();
        this.timers.set(channel, timer);
    }

    private async fire(
        subscription: NotifySubscription,
        payloads: string[],
    ): Promise<void> {
        try {
            await subscription.onWake(payloads);
        } catch (err: unknown) {
            // A consumer that throws must not kill the listener — the next
            // notification, or the consumer's own sweep, retries the work.
            this.logger.error(
                `Handler for ${subscription.channel} threw: ${String(err)}`,
            );
        }
    }
}
