import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body for POST /api/v1/skills. */
export class CreateSkillDto {
    @ApiProperty({
        description:
            'Catalog label, e.g. "Fragile Handling" or "Requires Liftgate". ' +
            'Unique per organisation.',
        example: 'Requires Liftgate',
        maxLength: 120,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(120)
    name: string;
}

/** A row from the organisation's skill catalog. */
export class SkillDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ format: 'uuid' })
    organisationId: string;

    @ApiProperty()
    name: string;

    @ApiPropertyOptional({
        type: String,
        format: 'date-time',
        nullable: true,
        description:
            'Set when the skill is retired. Archived skills cannot be newly ' +
            'assigned to a vehicle or required on a package, but existing ' +
            'assignments and historical routes keep referencing them.',
    })
    archivedAt: string | null;

    @ApiProperty({ format: 'date-time' })
    createdAt: string;
}
