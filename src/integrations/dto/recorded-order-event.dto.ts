import { ApiProperty } from '@nestjs/swagger';

/**
 * 200/201 body of `POST /api/v1/integrations/orders`. Phase 1 is record-only
 * (see HIK-99) — no customer or package is created yet, so the only thing
 * worth returning is the ledger row's own id.
 */
export class RecordedOrderEventDto {
    @ApiProperty({
        format: 'uuid',
        description: 'The integration_order_event row id.',
    })
    id: string;
}
