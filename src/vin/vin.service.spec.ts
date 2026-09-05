import { DecodeResult } from '@cardog/corgi';
import { VinService } from './vin.service';

const decodeMock = jest.fn();
const closeMock = jest.fn();

jest.mock('@cardog/corgi', () => ({
    createDecoder: jest.fn(() =>
        Promise.resolve({ decode: decodeMock, close: closeMock }),
    ),
}));

describe('VinService', () => {
    let service: VinService;

    beforeEach(async () => {
        decodeMock.mockReset();
        closeMock.mockReset();
        service = new VinService();
        await service.onModuleInit();
    });

    it('throws if decode is called before the decoder has initialised', async () => {
        const uninitialised = new VinService();
        await expect(uninitialised.decode('1HGCM82633A123456')).rejects.toThrow(
            'VIN decoder accessed before initialisation',
        );
    });

    it('normalises the VIN to uppercase and trimmed before decoding', async () => {
        decodeMock.mockResolvedValue({});

        await service.decode('  1hgcm82633a123456  ');

        expect(decodeMock).toHaveBeenCalledWith('1HGCM82633A123456');
    });

    it('returns the decode result verbatim, including reported errors', async () => {
        const result = {
            vin: 'INVALID',
            valid: false,
            components: {},
            errors: [
                {
                    code: '100',
                    category: 'structure',
                    severity: 'error',
                    message: 'Invalid length',
                },
            ],
        } as unknown as DecodeResult;
        decodeMock.mockResolvedValue(result);

        await expect(service.decode('INVALID')).resolves.toEqual(result);
    });

    it('closes the underlying decoder on module destroy', async () => {
        await service.onModuleDestroy();
        expect(closeMock).toHaveBeenCalled();
    });
});
