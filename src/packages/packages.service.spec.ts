import { BadRequestException, ConflictException } from '@nestjs/common';
import { PackagesService } from './packages.service';
import type { CreatePackageDto } from './dto/create-package.dto';

const NOW = '2026-09-01T09:00:00.000Z';

const STORED = {
    id: 'pkg-1',
    created_at: NOW,
    tracking_number: 'WDN000001',
    organisation_id: 'org-1',
    warehouse_id: 'wh-1',
    from_customer: 'cust-from',
    to_customer: 'cust-to',
    delivery_notes: null,
    scheduled_arrival: null,
    status: 'PENDING',
};

function dto(overrides: Partial<CreatePackageDto> = {}): CreatePackageDto {
    return {
        warehouseId: 'wh-1',
        fromCustomerId: 'cust-from',
        toCustomerId: 'cust-to',
        dimensions: { weightKg: 2.5, lengthCm: 30, widthCm: 20, heightCm: 15 },
        ...overrides,
    };
}

interface State {
    warehouse?: unknown[];
    customers?: unknown[];
    byTracking?: unknown[];
    stored?: unknown[];
    insertError?: Error;
}

function build(state: State = {}) {
    const log: { sql: string; params: unknown[] }[] = [];

    const answer = (sql: string, params: unknown[]): unknown[] => {
        if (sql.includes('FROM warehouse'))
            return state.warehouse ?? [{ id: 'wh-1' }];
        if (sql.includes('FROM customer')) {
            return state.customers ?? [{ id: 'cust-from' }, { id: 'cust-to' }];
        }
        if (sql.includes('p.tracking_number = $1'))
            return state.byTracking ?? [];
        if (sql.includes('p.id = $1')) return state.stored ?? [STORED];
        if (sql.includes('INSERT INTO packages')) {
            if (state.insertError) throw state.insertError;
            return [{ id: (params[0] as string) ?? 'pkg-1' }];
        }
        return [];
    };

    const query = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        try {
            return Promise.resolve(answer(sql, params));
        } catch (err) {
            return Promise.reject(err);
        }
    });

    const runner = {
        query,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        isTransactionActive: true,
    };
    const dataSource = { query, createQueryRunner: jest.fn(() => runner) };

    const assignment = {
        assign: jest.fn().mockResolvedValue({
            outcome: 'assigned',
            reason: null,
            shift: {
                id: 'shift-1',
                driverId: 'driver-1',
                vehicleId: 'vehicle-1',
                shiftDate: '2026-09-01',
                scheduledStart: null,
                stopIndex: 0,
                estimatedArrival: NOW,
                revision: 2,
            },
            evictedPackageIds: [],
        }),
        unassign: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PackagesService(
        dataSource as never,
        assignment as never,
    );
    return { service, assignment, runner, log, query };
}

describe('PackagesService', () => {
    describe('validation', () => {
        it('rejects a warehouse in another organisation as unknown', async () => {
            // Never "wrong organisation": that would confirm the row exists.
            const { service } = build({ warehouse: [] });
            await expect(service.create('org-1', dto())).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects a customer in another organisation as unknown', async () => {
            const { service } = build({ customers: [{ id: 'cust-from' }] });
            await expect(service.create('org-1', dto())).rejects.toThrow(
                /cust-to/,
            );
        });

        it('does not write anything when validation fails', async () => {
            const { service, log } = build({ warehouse: [] });
            await service.create('org-1', dto()).catch(() => undefined);
            expect(log.some((q) => q.sql.includes('INSERT'))).toBe(false);
        });
    });

    describe('creation', () => {
        it('writes the package, its dimensions, its window and its first status', async () => {
            const { service, log } = build();
            await service.create('org-1', dto());

            const written = log.map((q) => q.sql);
            expect(
                written.some((s) => s.includes('INSERT INTO packages')),
            ).toBe(true);
            expect(
                written.some((s) =>
                    s.includes('INSERT INTO package_dimensions'),
                ),
            ).toBe(true);
            expect(
                written.some((s) =>
                    s.includes('INSERT INTO package_delivery_window'),
                ),
            ).toBe(true);
            expect(
                written.some((s) => s.includes('insert_package_timeline')),
            ).toBe(true);
        });

        it('commits creation BEFORE assignment runs', async () => {
            // The rule the whole endpoint turns on: a package is never lost
            // because no van had room for it.
            const order: string[] = [];
            const { service, runner, assignment } = build();
            runner.commitTransaction.mockImplementation(() => {
                order.push('commit');
                return Promise.resolve();
            });
            assignment.assign.mockImplementation(() => {
                order.push('assign');
                return Promise.resolve({
                    outcome: 'deferred',
                    reason: 'no_capacity',
                    shift: null,
                    evictedPackageIds: [],
                });
            });

            await service.create('org-1', dto());
            expect(order).toEqual(['commit', 'assign']);
        });

        it('still returns the package when assignment defers it', async () => {
            const { service, assignment } = build();
            assignment.assign.mockResolvedValue({
                outcome: 'deferred',
                reason: 'shift_allowance_exhausted',
                shift: null,
                evictedPackageIds: [],
            });

            const { result } = await service.create('org-1', dto());
            expect(result.package.id).toBe('pkg-1');
            expect(result.assignment).toEqual({
                outcome: 'deferred',
                reason: 'shift_allowance_exhausted',
                shift: null,
                evictedPackageIds: [],
            });
        });

        it('surfaces the driver, the stop and the ETA when it lands', async () => {
            const { service } = build();
            const { result } = await service.create('org-1', dto());
            expect(result.assignment.outcome).toBe('assigned');
            expect(result.assignment.shift).toMatchObject({
                driverId: 'driver-1',
                stopIndex: 0,
                estimatedArrival: NOW,
            });
        });

        it('honours a client-supplied id, so the photo storage path still works', async () => {
            const { service, log } = build({
                stored: [{ ...STORED, id: 'client-uuid' }],
            });
            await service.create('org-1', dto({ id: 'client-uuid' }));

            const insert = log.find((q) =>
                q.sql.includes('INSERT INTO packages'),
            );
            expect(insert?.params[0]).toBe('client-uuid');
        });

        it('passes a null tracking number so the database trigger generates one', async () => {
            // An empty string would be stored verbatim and collide on the second
            // package: set_tracking_number() only fires on NULL.
            const { service, log } = build();
            await service.create('org-1', dto());

            const insert = log.find((q) =>
                q.sql.includes('INSERT INTO packages'),
            );
            expect(insert?.params[6]).toBeNull();
        });

        it('writes the deadline to scheduled_arrival and nothing to the ETA', async () => {
            const { service, log } = build();
            await service.create(
                'org-1',
                dto({ deadlineAt: '2026-09-02T17:00:00Z' }),
            );

            const window = log.find((q) =>
                q.sql.includes('INSERT INTO package_delivery_window'),
            );
            expect(window?.sql).toContain('scheduled_arrival');
            expect(window?.sql).not.toContain('estimated_arrival');
            expect(window?.params[2]).toBe('2026-09-02T17:00:00Z');
        });

        it('rolls back the whole creation if any of the four writes fails', async () => {
            const { service, runner } = build({
                insertError: new Error('constraint violation'),
            });
            await expect(service.create('org-1', dto())).rejects.toThrow();
            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(runner.commitTransaction).not.toHaveBeenCalled();
        });

        it('reports a lost insert race on the tracking number as a conflict', async () => {
            const { service } = build({
                insertError: Object.assign(new Error('duplicate key'), {
                    code: '23505',
                }),
            });
            await expect(
                service.create('org-1', dto({ trackingNumber: 'WDN000001' })),
            ).rejects.toBeInstanceOf(ConflictException);
        });
    });

    describe('autoAssign', () => {
        it('skips assignment when the wizard asks it to', async () => {
            // The mobile create-shift wizard hands the id to /optimisation/adhoc
            // next, which rejects a package that already belongs to an
            // optimisation. Auto-assigning here 409s the wizard on first use.
            const { service, assignment } = build();
            const { result } = await service.create(
                'org-1',
                dto({ autoAssign: false }),
            );

            expect(assignment.assign).not.toHaveBeenCalled();
            expect(result.assignment).toEqual({
                outcome: 'skipped',
                reason: 'auto_assign_disabled',
                shift: null,
                evictedPackageIds: [],
            });
        });

        it('assigns by default when the field is absent', async () => {
            const { service, assignment } = build();
            await service.create('org-1', dto());
            expect(assignment.assign).toHaveBeenCalled();
        });
    });

    describe('idempotent replay', () => {
        it('returns the original package for an identical payload', async () => {
            const { service, log } = build({ byTracking: [STORED] });
            const { result, replayed } = await service.create(
                'org-1',
                dto({ trackingNumber: 'WDN000001' }),
            );

            expect(replayed).toBe(true);
            expect(result.package.id).toBe('pkg-1');
            expect(
                log.some((q) => q.sql.includes('INSERT INTO packages')),
            ).toBe(false);
        });

        it('conflicts when the same tracking number describes a different delivery', async () => {
            const { service } = build({
                byTracking: [{ ...STORED, to_customer: 'someone-else' }],
            });
            await expect(
                service.create('org-1', dto({ trackingNumber: 'WDN000001' })),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('conflicts when the depot differs', async () => {
            const { service } = build({
                byTracking: [{ ...STORED, warehouse_id: 'wh-other' }],
            });
            await expect(
                service.create('org-1', dto({ trackingNumber: 'WDN000001' })),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('tolerates corrected notes on a retry rather than refusing it', async () => {
            // The match is deliberately narrow — sender, recipient, depot. Those
            // are what make it a different delivery; notes can legitimately be
            // fixed on a retry, and refusing that turns a flaky connection into a
            // support ticket.
            const { service } = build({
                byTracking: [{ ...STORED, delivery_notes: 'old note' }],
            });
            const { replayed } = await service.create(
                'org-1',
                dto({
                    trackingNumber: 'WDN000001',
                    deliveryNotes: 'ring the bell',
                }),
            );
            expect(replayed).toBe(true);
        });
    });

    describe('createBulk', () => {
        it('returns index-aligned results', async () => {
            const { service } = build();
            const out = await service.createBulk('org-1', {
                packages: [dto(), dto()],
            });
            expect(out.results.map((r) => r.index)).toEqual([0, 1]);
            expect(out.results.every((r) => r.result !== null)).toBe(true);
        });

        it('lets one bad entry fail without taking the batch with it', async () => {
            let call = 0;
            const { service } = build();
            const original = service['validateReferences'].bind(service);
            jest.spyOn(
                service as unknown as {
                    validateReferences: () => Promise<void>;
                },
                'validateReferences',
            ).mockImplementation(((org: string, d: CreatePackageDto) => {
                call += 1;
                if (call === 1) {
                    return Promise.reject(
                        new BadRequestException('bad warehouse'),
                    );
                }
                return original(org, d);
            }) as never);

            const out = await service.createBulk('org-1', {
                packages: [dto(), dto()],
            });

            expect(out.results[0]).toMatchObject({ index: 0, result: null });
            expect(out.results[0].error).toContain('bad warehouse');
            expect(out.results[1].result).not.toBeNull();
        });
    });

    describe('reassign', () => {
        it('detaches then assigns again', async () => {
            const { service, assignment } = build();
            await service.reassign('org-1', 'pkg-1');
            expect(assignment.unassign).toHaveBeenCalledWith('org-1', 'pkg-1');
            expect(assignment.assign).toHaveBeenCalledWith('org-1', 'pkg-1');
        });

        it('404s for a package in another organisation', async () => {
            const { service } = build({ stored: [] });
            await expect(service.reassign('org-1', 'pkg-1')).rejects.toThrow(
                /not found/i,
            );
        });
    });

    describe('createMany', () => {
        it('writes on the caller’s transaction and does not assign', async () => {
            // The booking checkout needs the packages and the payment row to
            // commit together.
            const { service, runner, assignment } = build();
            const ids = await service.createMany(runner as never, 'org-1', [
                {
                    warehouseId: 'wh-1',
                    fromCustomerId: 'cust-from',
                    toCustomerId: 'cust-to',
                    weightKg: 1,
                    lengthCm: 1,
                    widthCm: 1,
                    heightCm: 1,
                },
            ]);

            expect(ids).toHaveLength(1);
            expect(runner.startTransaction).not.toHaveBeenCalled();
            expect(assignment.assign).not.toHaveBeenCalled();
        });
    });

    describe('assignCreated', () => {
        it('assigns each package and swallows a deferral', async () => {
            const { service, assignment } = build();
            assignment.assign.mockResolvedValue({
                outcome: 'deferred',
                reason: 'no_capacity',
                shift: null,
                evictedPackageIds: [],
            });

            await expect(
                service.assignCreated('org-1', ['pkg-1', 'pkg-2']),
            ).resolves.toBeUndefined();
            expect(assignment.assign).toHaveBeenCalledTimes(2);
        });
    });
});
