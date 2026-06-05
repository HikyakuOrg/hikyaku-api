import { PartialType } from '@nestjs/swagger';
import { CreateAddonDto } from './create-addon.dto';

/**
 * Edit an add-on. All fields are optional — only the supplied ones change.
 * Currency is inherited from the parent service and isn't editable.
 */
export class UpdateAddonDto extends PartialType(CreateAddonDto) {}
