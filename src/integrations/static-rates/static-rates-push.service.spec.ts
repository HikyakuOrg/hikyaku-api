import { createHmac } from 'crypto';
import type { DataSource } from 'typeorm';
import type { PgNotifyService } from 'src/dispatch/pg-notify.service';
import { STATIC_RATES_CHANNEL } from './notify';
import {
    StaticRatesPushService,
    parseChange,
    signPush,
} from './static-rates-push.service';

const ORG_A = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ORG_B = 'b1ffcd00-0d1c-4ef8-bb6d-6bb9bd380a22';
const URL = 'https://app.example/hikyaku/resync';
const SECRET = 'push-secret';

describe('parseChange', () => {
    it('reads an organisation-wide change', () => {
        expect(parseChange(`${ORG_A}|service_areas`)).toEqual({
            organisationId: ORG_A,
            reason: 'service_areas',
        });
    });

    it('reads a one-shop change', () => {
        expect(
            parseChange(`${ORG_A}|settings|shopify|store.myshopify.com`),
        ).toEqual({
            organisationId: ORG_A,
            reason: 'settings',
            shop: { platform: 'shopify', shopDomain: 'store.myshopify.com' },
        });
    });

    it('ignores anything else', () => {
        expect(parseChange('')).toBeNull();
        expect(parseChange(ORG_A)).toBeNull();
    });
});

describe('signPush', () => {
    it('signs "<timestamp>.<body>" the way the app verifies it', () => {
        const body = '{"platform":"shopify"}';
        const headers = signPush(SECRET, body, 1_790_000_000);
        const expected = createHmac('sha256', SECRET)
            .update(`1790000000.${body}`)
            .digest('hex');
        expect(headers).toEqual({
            'Content-Type': 'application/json',
            'X-Hikyaku-Timestamp': '1790000000',
            'X-Hikyaku-Signature': `sha256=${expected}`,
        });
    });
});

describe('StaticRatesPushService', () => {
    let service: StaticRatesPushService;
    let query: jest.Mock;
    let subscribe: jest.Mock;
    let fetchMock: jest.Mock;
    const realFetch = global.fetch;

    const shops = [
        {
            organisation_id: ORG_A,
            platform: 'shopify',
            shop_domain: 'one.myshopify.com',
        },
        {
            organisation_id: ORG_A,
            platform: 'shopify',
            shop_domain: 'two.myshopify.com',
        },
        {
            organisation_id: ORG_B,
            platform: 'shopify',
            shop_domain: 'other.myshopify.com',
        },
    ];

    function pushedBodies(): { shop_domain: string; reasons: string[] }[] {
        return fetchMock.mock.calls.map(
            ([, init]) =>
                JSON.parse((init as RequestInit).body as string) as {
                    shop_domain: string;
                    reasons: string[];
                },
        );
    }

    beforeEach(() => {
        process.env.HIKYAKU_SHOPIFY_PUSH_URL = URL;
        process.env.HIKYAKU_SHOPIFY_PUSH_SECRET = SECRET;
        query = jest.fn((_sql: string, [orgs]: [string[]]) =>
            Promise.resolve(
                shops.filter((s) => orgs.includes(s.organisation_id)),
            ),
        );
        subscribe = jest.fn();
        fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        global.fetch = fetchMock;
        service = new StaticRatesPushService(
            { query } as unknown as DataSource,
            { subscribe } as unknown as PgNotifyService,
        );
    });

    afterEach(() => {
        service.onModuleDestroy();
        global.fetch = realFetch;
        delete process.env.HIKYAKU_SHOPIFY_PUSH_URL;
        delete process.env.HIKYAKU_SHOPIFY_PUSH_SECRET;
        jest.useRealTimers();
    });

    it('listens on the static rates channel with a debounce', () => {
        service.onApplicationBootstrap();
        const [subscription] = subscribe.mock.calls[0] as [
            { channel: string; debounceMs: number },
        ];
        expect(subscription.channel).toBe(STATIC_RATES_CHANNEL);
        expect(subscription.debounceMs).toBeGreaterThan(0);
    });

    it('does nothing on the empty wake after a reconnect', async () => {
        await service.handle([]);
        expect(query).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('asks only for enabled static shops of the changed organisations', async () => {
        await service.handle([`${ORG_A}|drivers`, `${ORG_A}|service_areas`]);
        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain("enabled AND path = 'static'");
        expect(params).toEqual([[ORG_A]]);
    });

    it('coalesces a burst into one signed push per shop', async () => {
        await service.handle([
            `${ORG_A}|service_areas`,
            `${ORG_A}|drivers`,
            `${ORG_A}|service_areas`,
            `${ORG_B}|catalog`,
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(pushedBodies()).toEqual([
            {
                platform: 'shopify',
                shop_domain: 'one.myshopify.com',
                reasons: ['drivers', 'service_areas'],
            },
            {
                platform: 'shopify',
                shop_domain: 'two.myshopify.com',
                reasons: ['drivers', 'service_areas'],
            },
            {
                platform: 'shopify',
                shop_domain: 'other.myshopify.com',
                reasons: ['catalog'],
            },
        ]);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(URL);
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Hikyaku-Signature']).toBe(
            signPush(
                SECRET,
                init.body as string,
                Number(headers['X-Hikyaku-Timestamp']),
            )['X-Hikyaku-Signature'],
        );
    });

    it('pushes a one-shop change to that shop only', async () => {
        await service.handle([`${ORG_A}|locations|shopify|two.myshopify.com`]);
        expect(pushedBodies()).toEqual([
            expect.objectContaining({
                shop_domain: 'two.myshopify.com',
                reasons: ['locations'],
            }),
        ]);
    });

    it('sends nothing without a push URL or secret', async () => {
        delete process.env.HIKYAKU_SHOPIFY_PUSH_SECRET;
        await service.handle([`${ORG_A}|drivers`]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries a 5xx, then gives up', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValue({ ok: false, status: 503 });
        await service.handle([`${ORG_B}|catalog`]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(5_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries a network error', async () => {
        jest.useFakeTimers();
        fetchMock
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValue({ ok: true, status: 200 });
        await service.handle([`${ORG_B}|catalog`]);
        await jest.advanceTimersByTimeAsync(5_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 4xx', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValue({ ok: false, status: 401 });
        await service.handle([`${ORG_B}|catalog`]);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('cancels pending retries on shutdown', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        await service.handle([`${ORG_B}|catalog`]);
        service.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
