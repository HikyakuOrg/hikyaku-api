import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrsService } from 'src/ors/ors.service';
import type { DirectionsResponse } from 'src/ors/ors.types';
import { ServiceRate } from './entities/service-rate.entity';
import { CalculateServiceFeeDto, ReceiverDto } from './dto/calculate-service-fee.dto';
import { ServiceFeeResponseDto, StorageReceiverDto } from './dto/service-fee-response.dto';

@Injectable()
export class ServiceFeesService {
    constructor(
        @InjectRepository(ServiceRate)
        private readonly serviceRateRepo: Repository<ServiceRate>,
        private readonly orsService: OrsService,
    ) {}

    async calculate(dto: CalculateServiceFeeDto): Promise<ServiceFeeResponseDto> {
        const rate = await this.serviceRateRepo.findOne({ where: { id: dto.serviceRateId } });
        if (!rate) {
            throw new NotFoundException(`Service rate ${dto.serviceRateId} not found`);
        }

        const totalDistance = await this.getRouteDistance(dto, rate.distanceUnit);

        const baseRate = Number(rate.baseRate);
        const ratePerDistance = Number(rate.ratePerDistance);
        const distanceCost = ratePerDistance * totalDistance;

        const signatureCharge =
            rate.hasSignatureCharge && rate.signatureCharge != null
                ? Number(rate.signatureCharge)
                : 0;
        const signatureCost = signatureCharge * dto.receiver.length;

        const storagePerDay = rate.storagePerDay != null ? Number(rate.storagePerDay) : null;
        const { totalStorageCost, storageReceivers } = this.calcStorageCost(
            dto.sender.collectionDate,
            dto.receiver,
            storagePerDay,
        );

        const total = parseFloat((baseRate + distanceCost + signatureCost + totalStorageCost).toFixed(2));

        return {
            currency: rate.currency,
            service_rate: { id: rate.id, name: rate.name },
            breakdown: {
                base_rate: parseFloat(baseRate.toFixed(2)),
                distance: {
                    total: parseFloat(totalDistance.toFixed(4)),
                    unit: rate.distanceUnit,
                    rate_per_unit: parseFloat(ratePerDistance.toFixed(4)),
                    cost: parseFloat(distanceCost.toFixed(2)),
                },
                signature: {
                    applies: rate.hasSignatureCharge,
                    charge_per_receiver: parseFloat(signatureCharge.toFixed(2)),
                    receiver_count: dto.receiver.length,
                    cost: parseFloat(signatureCost.toFixed(2)),
                },
                storage: {
                    applies: totalStorageCost > 0,
                    rate_per_day: storagePerDay != null ? parseFloat(storagePerDay.toFixed(2)) : 0,
                    receivers: storageReceivers,
                    cost: parseFloat(totalStorageCost.toFixed(2)),
                },
            },
            total,
        };
    }

    private async getRouteDistance(dto: CalculateServiceFeeDto, unit: string): Promise<number> {
        const coordinates = [
            [dto.sender.address.lon, dto.sender.address.lat],
            ...dto.receiver.map((r) => [r.address.lon, r.address.lat]),
        ];

        let orsResult: DirectionsResponse;
        try {
            orsResult = (await this.orsService.proxyPost('/v2/directions/driving-car', {
                coordinates,
                units: unit,
            })) as DirectionsResponse;
        } catch {
            throw new ServiceUnavailableException('Distance calculation unavailable');
        }

        if (!orsResult?.routes?.length) {
            throw new ServiceUnavailableException('Distance calculation unavailable');
        }

        return orsResult.routes[0].summary.distance;
    }

    private calcStorageCost(
        collectionDate: string,
        receivers: ReceiverDto[],
        storagePerDay: number | null,
    ): { totalStorageCost: number; storageReceivers: StorageReceiverDto[] } {
        const storageReceivers: StorageReceiverDto[] = [];
        let totalStorageCost = 0;

        if (storagePerDay == null) {
            return { totalStorageCost: 0, storageReceivers: [] };
        }

        const collection = new Date(collectionDate + 'T00:00:00Z');

        for (const receiver of receivers) {
            const delivery = new Date(receiver.deliveryDate + 'T00:00:00Z');
            const daysDiff = Math.round(
                (delivery.getTime() - collection.getTime()) / (1000 * 60 * 60 * 24),
            );

            if (daysDiff > 1) {
                const cost = parseFloat((storagePerDay * daysDiff).toFixed(2));
                totalStorageCost += cost;
                storageReceivers.push({ name: receiver.name, days: daysDiff, cost });
            }
        }

        return { totalStorageCost: parseFloat(totalStorageCost.toFixed(2)), storageReceivers };
    }
}
