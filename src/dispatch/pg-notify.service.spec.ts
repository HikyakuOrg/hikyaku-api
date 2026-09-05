import type { EventEmitter } from 'events';
import { PgNotifyService } from './pg-notify.service';

/**
 * A stand-in for pg.Client that lets a test drive connect / notify / drop by
 * hand.
 *
 * The fake is declared inside the jest.mock factory and its instances are parked
 * on globalThis: the factory runs while `./pg-notify.service` is being imported,
 * which is before any module-level `const` in this file has been initialised, so
 * anything it closes over would be in the temporal dead zone.
 */
interface FakeClient extends EventEmitter {
    connect: jest.Mock;
    query: jest.Mock;
    end: jest.Mock;
    notify(channel: string, payload?: string): void;
}

declare global {
    var __pgClients: FakeClient[] | undefined;
    /** How many of the next connect() attempts should fail. */

    var __pgConnectFails: number | undefined;
}

jest.mock('pg', () => {
    const { EventEmitter: Emitter } =
        jest.requireActual<typeof import('events')>('events');

    class Client extends Emitter {
        connect = jest.fn().mockImplementation(() => {
            const remaining = globalThis.__pgConnectFails ?? 0;
            if (remaining > 0) {
                globalThis.__pgConnectFails = remaining - 1;
                return Promise.reject(new Error('connection refused'));
            }
            return Promise.resolve();
        });
        query = jest.fn().mockResolvedValue({ rows: [] });
        end = jest.fn().mockResolvedValue(undefined);

        constructor(public readonly config: { connectionString?: string }) {
            super();
            globalThis.__pgClients ??= [];
            globalThis.__pgClients.push(this);
        }

        notify(channel: string, payload?: string): void {
            this.emit('notification', { channel, payload });
        }
    }

    return { Client };
});

const clients = (): FakeClient[] => globalThis.__pgClients ?? [];

describe('PgNotifyService', () => {
    let service: PgNotifyService;
    const originalDbUrl = process.env.DB_URL;

    beforeEach(() => {
        jest.useFakeTimers();
        globalThis.__pgClients = [];
        globalThis.__pgConnectFails = 0;
        process.env.DB_URL = 'postgres://localhost/test';
        service = new PgNotifyService();
    });

    afterEach(async () => {
        await service.onModuleDestroy();
        jest.useRealTimers();
        if (originalDbUrl === undefined) delete process.env.DB_URL;
        else process.env.DB_URL = originalDbUrl;
    });

    const client = (): FakeClient => clients()[clients().length - 1];

    it('does nothing without a database URL rather than crash-looping', async () => {
        delete process.env.DB_URL;
        await service.onApplicationBootstrap();
        expect(clients()).toHaveLength(0);
        expect(service.isConnected()).toBe(false);
    });

    it('opens a dedicated client and LISTENs on every registered channel', async () => {
        service.subscribe({
            channel: 'ch_a',
            debounceMs: 10,
            onWake: jest.fn(),
        });
        service.subscribe({
            channel: 'ch_b',
            debounceMs: 10,
            onWake: jest.fn(),
        });
        await service.onApplicationBootstrap();

        // One client, not a pooled connection — a pool would hand the socket to
        // another query and silently drop the registration.
        expect(clients()).toHaveLength(1);
        expect(client().query).toHaveBeenCalledWith('LISTEN "ch_a"');
        expect(client().query).toHaveBeenCalledWith('LISTEN "ch_b"');
        expect(service.isConnected()).toBe(true);
    });

    it('drains once on connect, because anything sent while connecting reached nobody', async () => {
        const onWake = jest.fn();
        service.subscribe({ channel: 'ch', debounceMs: 3_000, onWake });
        await service.onApplicationBootstrap();

        expect(onWake).toHaveBeenCalledTimes(1);
        expect(onWake).toHaveBeenCalledWith([]);
    });

    it('coalesces a burst of notifications into a single wake', async () => {
        const onWake = jest.fn();
        service.subscribe({ channel: 'ch', debounceMs: 3_000, onWake });
        await service.onApplicationBootstrap();
        onWake.mockClear();

        for (let i = 0; i < 500; i++) client().notify('ch', `shift-${i % 3}`);

        // Trailing edge: nothing has fired yet.
        expect(onWake).not.toHaveBeenCalled();

        jest.advanceTimersByTime(3_000);
        expect(onWake).toHaveBeenCalledTimes(1);
        // 500 notifications naming three shifts is three distinct payloads.
        expect(onWake.mock.calls[0][0].sort()).toEqual([
            'shift-0',
            'shift-1',
            'shift-2',
        ]);
    });

    it('starts a fresh window after one closes', async () => {
        const onWake = jest.fn();
        service.subscribe({ channel: 'ch', debounceMs: 1_000, onWake });
        await service.onApplicationBootstrap();
        onWake.mockClear();

        client().notify('ch', 'a');
        jest.advanceTimersByTime(1_000);
        client().notify('ch', 'b');
        jest.advanceTimersByTime(1_000);

        expect(onWake).toHaveBeenCalledTimes(2);
        expect(onWake.mock.calls[1][0]).toEqual(['b']);
    });

    it('ignores a notification on a channel nobody subscribed to', async () => {
        const onWake = jest.fn();
        service.subscribe({ channel: 'ch', debounceMs: 1_000, onWake });
        await service.onApplicationBootstrap();
        onWake.mockClear();

        client().notify('some_other_channel', 'x');
        jest.advanceTimersByTime(5_000);
        expect(onWake).not.toHaveBeenCalled();
    });

    it('re-LISTENs and drains again after the connection drops', async () => {
        const onWake = jest.fn();
        service.subscribe({ channel: 'ch', debounceMs: 1_000, onWake });
        await service.onApplicationBootstrap();
        onWake.mockClear();

        client().emit('error', new Error('connection reset'));
        expect(service.isConnected()).toBe(false);

        await jest.advanceTimersByTimeAsync(1_000);

        expect(clients()).toHaveLength(2);
        expect(client().query).toHaveBeenCalledWith('LISTEN "ch"');
        // The drain is the point: notifications fired while the socket was down
        // were delivered to nobody, so the consumer has to go looking.
        expect(onWake).toHaveBeenCalledWith([]);
    });

    it('backs off while the connection keeps refusing, instead of spinning', async () => {
        globalThis.__pgConnectFails = 2;
        service.subscribe({ channel: 'ch', debounceMs: 10, onWake: jest.fn() });

        await service.onApplicationBootstrap();
        expect(clients()).toHaveLength(1);
        expect(service.isConnected()).toBe(false);

        // First retry after 1s, and it fails too.
        await jest.advanceTimersByTimeAsync(1_000);
        expect(clients()).toHaveLength(2);

        // Second retry waits twice as long: nothing at +1s, a client at +2s.
        await jest.advanceTimersByTimeAsync(1_000);
        expect(clients()).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(clients()).toHaveLength(3);
        expect(service.isConnected()).toBe(true);
    });

    it('resets the backoff once a connection succeeds', async () => {
        service.subscribe({ channel: 'ch', debounceMs: 10, onWake: jest.fn() });
        await service.onApplicationBootstrap();

        // Two clean drops in a row each reconnect after the minimum delay,
        // because the successful connection in between cleared the backoff.
        client().emit('end');
        await jest.advanceTimersByTimeAsync(1_000);
        expect(clients()).toHaveLength(2);

        client().emit('end');
        await jest.advanceTimersByTimeAsync(1_000);
        expect(clients()).toHaveLength(3);
    });

    it('LISTENs immediately for a channel subscribed after connecting', async () => {
        await service.onApplicationBootstrap();
        service.subscribe({
            channel: 'late',
            debounceMs: 10,
            onWake: jest.fn(),
        });
        await Promise.resolve();
        expect(client().query).toHaveBeenCalledWith('LISTEN "late"');
    });

    it('survives a handler that throws', async () => {
        const onWake = jest
            .fn()
            .mockRejectedValue(new Error('consumer blew up'));
        service.subscribe({ channel: 'ch', debounceMs: 100, onWake });
        await service.onApplicationBootstrap();

        client().notify('ch', 'a');
        await jest.advanceTimersByTimeAsync(100);

        // Still listening: a broken consumer must not take the listener with it.
        expect(service.isConnected()).toBe(true);
    });

    it('stops reconnecting once the module is destroyed', async () => {
        service.subscribe({ channel: 'ch', debounceMs: 10, onWake: jest.fn() });
        await service.onApplicationBootstrap();
        const live = client();

        await service.onModuleDestroy();
        expect(live.end).toHaveBeenCalled();

        live.emit('end');
        await jest.advanceTimersByTimeAsync(60_000);
        expect(clients()).toHaveLength(1);
    });
});
