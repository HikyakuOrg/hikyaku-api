import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateServiceDto } from './create-service.dto';

/**
 * Edit a service. All fields are optional — only the supplied ones change.
 * `currency` is omitted: it is fixed at creation (the connected account default)
 * and inherited by add-ons, so it can't be edited in place.
 */
export class UpdateServiceDto extends PartialType(
    OmitType(CreateServiceDto, ['currency'] as const),
) {}
