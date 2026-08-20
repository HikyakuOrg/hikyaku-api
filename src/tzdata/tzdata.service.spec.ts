import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Worker } from 'node:worker_threads';
import { TzdataService } from './tzdata.service';
import { TzdataWorkerMessage } from './tzdata.constants';

jest.mock('node:worker_threads', () => ({
    Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));

describe('TzdataService', () => {
    let service: TzdataService;
    let dsQuery: jest.Mock;

    beforeEach(async () => {
        dsQuery = jest.fn();
        (Worker as unknown as jest.Mock).mockClear();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TzdataService,
                { provide: getDataSourceToken(), useValue: { query: dsQuery } },
            ],
        }).compile();

        service = module.get(TzdataService);
    });

    /** Grabs the event handler TzdataService registered on the mocked worker. */
    function getHandler(event: string): ((...args: unknown[]) => void) | undefined {
        const instance = (Worker as unknown as jest.Mock).mock.results[0].value;
        const onCalls: [string, (...args: unknown[]) => void][] = instance.on.mock.calls;
        return onCalls.find(([e]) => e === event)?.[1];
    }

    it('skips the import worker when the table already has rows', async () => {
        dsQuery
            .mockResolvedValueOnce([{ exists: true }])
            .mockResolvedValueOnce([{ exists: true }]);

        await service.onApplicationBootstrap();

        expect(dsQuery).toHaveBeenCalledTimes(2);
        expect(Worker).not.toHaveBeenCalled();
        expect(service.getImportState().importState).toBe('skipped_already_populated');
    });

    it('starts the import worker when the table does not exist yet', async () => {
        dsQuery.mockResolvedValueOnce([{ exists: false }]);

        await service.onApplicationBootstrap();

        expect(dsQuery).toHaveBeenCalledTimes(1);
        expect(Worker).toHaveBeenCalledTimes(1);
        // Nothing has reported back from the (mocked) worker yet.
        expect(service.getImportState().importState).toBe('checking');
    });

    it('starts the import worker when the table exists but is empty', async () => {
        dsQuery
            .mockResolvedValueOnce([{ exists: true }])
            .mockResolvedValueOnce([{ exists: false }]);

        await service.onApplicationBootstrap();

        expect(Worker).toHaveBeenCalledTimes(1);
    });

    it('tracks status messages posted by the worker', async () => {
        dsQuery.mockResolvedValueOnce([{ exists: false }]);
        await service.onApplicationBootstrap();

        const onMessage = getHandler('message');
        onMessage?.({ type: 'status', phase: 'downloading' } satisfies TzdataWorkerMessage);
        expect(service.getImportState().importState).toBe('downloading');

        onMessage?.({ type: 'log', message: 'hello' } satisfies TzdataWorkerMessage);
        expect(service.getImportState().importState).toBe('downloading'); // log doesn't change phase

        onMessage?.({ type: 'status', phase: 'completed' } satisfies TzdataWorkerMessage);
        expect(service.getImportState().importState).toBe('completed');
    });

    it('marks failed with the error message when the worker crashes', async () => {
        dsQuery.mockResolvedValueOnce([{ exists: false }]);
        await service.onApplicationBootstrap();

        expect(() => getHandler('error')?.(new Error('boom'))).not.toThrow();
        expect(service.getImportState()).toMatchObject({ importState: 'failed', error: 'boom' });

        // A subsequent non-zero exit must not clobber the real error message.
        expect(() => getHandler('exit')?.(1)).not.toThrow();
        expect(service.getImportState()).toMatchObject({ importState: 'failed', error: 'boom' });
    });

    it('marks failed on a non-zero exit with no prior error event (e.g. killed)', async () => {
        dsQuery.mockResolvedValueOnce([{ exists: false }]);
        await service.onApplicationBootstrap();

        expect(() => getHandler('exit')?.(137)).not.toThrow();
        expect(service.getImportState()).toMatchObject({
            importState: 'failed',
            error: 'Worker exited with code 137.',
        });
    });

    it('handles a non-Error value passed to the error event', async () => {
        dsQuery.mockResolvedValueOnce([{ exists: false }]);
        await service.onApplicationBootstrap();

        expect(() => getHandler('error')?.('non-error value')).not.toThrow();
        expect(service.getImportState()).toMatchObject({ importState: 'failed', error: 'non-error value' });
    });

    it('does not error on a clean exit', async () => {
        dsQuery.mockResolvedValueOnce([{ exists: false }]);
        await service.onApplicationBootstrap();

        expect(() => getHandler('exit')?.(0)).not.toThrow();
    });
});
