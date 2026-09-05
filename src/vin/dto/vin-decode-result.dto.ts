import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shape of the VIN decode endpoint. Corgi decodes offline against a
 * bundled NHTSA vPIC snapshot and the service passes its result through
 * verbatim, so these classes describe corgi's `DecodeResult` rather than a
 * Hikyaku-owned contract.
 *
 * Properties are declaration-only: nothing constructs these — they exist so
 * @nestjs/swagger can emit a response schema and generated clients get a typed
 * result instead of `Unit`/`void`.
 */
export class VehicleInfoDto {
    @ApiProperty({ example: 'Hyundai' })
    make: string;

    @ApiProperty({ example: 'Kona' })
    model: string;

    @ApiProperty({ example: 2023 })
    year: number;

    @ApiPropertyOptional()
    series?: string;

    @ApiPropertyOptional()
    trim?: string;

    @ApiPropertyOptional({ example: 'SUV' })
    bodyStyle?: string;

    @ApiPropertyOptional({ example: 'AWD' })
    driveType?: string;

    @ApiPropertyOptional()
    engineType?: string;

    @ApiPropertyOptional()
    fuelType?: string;

    @ApiPropertyOptional()
    transmission?: string;

    @ApiPropertyOptional()
    doors?: string;

    @ApiPropertyOptional({ description: 'Gross Vehicle Weight Rating.' })
    gvwr?: string;

    @ApiPropertyOptional()
    manufacturer?: string;
}

export class WmiResultDto {
    @ApiProperty({ description: '3-character World Manufacturer Identifier.' })
    code: string;

    @ApiProperty()
    manufacturer: string;

    @ApiProperty({ description: 'Manufacturing country.' })
    country: string;

    @ApiProperty()
    vehicleType: string;

    @ApiProperty({ description: 'Geographic region.' })
    region: string;

    @ApiProperty()
    make: string;
}

export class ModelYearResultDto {
    @ApiProperty({ example: 2023 })
    year: number;

    @ApiProperty({ enum: ['position', 'override', 'calculated'] })
    source: 'position' | 'override' | 'calculated';

    @ApiProperty({ description: 'Confidence in the year, from 0 to 1.' })
    confidence: number;
}

export class CheckDigitResultDto {
    @ApiProperty({ description: 'Position in the VIN, typically 9.' })
    position: number;

    @ApiProperty({ description: 'Actual check digit character from the VIN.' })
    actual: string;

    @ApiPropertyOptional({
        description: 'Check digit calculated from the VIN.',
    })
    expected?: string;

    @ApiProperty()
    isValid: boolean;
}

export class PlantInfoDto {
    @ApiProperty({ description: 'Manufacturing country.' })
    country: string;

    @ApiPropertyOptional({ description: 'Manufacturing city.' })
    city?: string;

    @ApiPropertyOptional()
    manufacturer?: string;

    @ApiProperty({ description: 'Plant code, from VIN position 11.' })
    code: string;
}

export class EngineInfoDto {
    @ApiPropertyOptional()
    type?: string;

    @ApiPropertyOptional({ description: 'Engine model code.' })
    model?: string;

    @ApiPropertyOptional()
    cylinders?: string;

    @ApiPropertyOptional({ description: 'Displacement in liters.' })
    displacement?: string;

    @ApiPropertyOptional()
    fuel?: string;

    @ApiPropertyOptional({ description: 'Engine power in HP.' })
    power?: string;
}

export class VinComponentsDto {
    @ApiPropertyOptional({ type: WmiResultDto })
    wmi?: WmiResultDto;

    @ApiPropertyOptional({ type: ModelYearResultDto })
    modelYear?: ModelYearResultDto;

    @ApiPropertyOptional({ type: CheckDigitResultDto })
    checkDigit?: CheckDigitResultDto;

    @ApiPropertyOptional({ type: VehicleInfoDto })
    vehicle?: VehicleInfoDto;

    @ApiPropertyOptional({ type: PlantInfoDto })
    plant?: PlantInfoDto;

    @ApiPropertyOptional({ type: EngineInfoDto })
    engine?: EngineInfoDto;
}

/**
 * One entry of corgi's `errors` array. Corgi's real type is a union
 * (validation/structure/lookup/pattern/database errors) with a few
 * category-specific extra fields — merged into one optional-everything shape
 * here since nothing constructs this and @nestjs/swagger has no clean way to
 * document a discriminated union with per-variant fields.
 */
export class DecodeErrorDto {
    @ApiProperty({
        description:
            'Numeric-string error code, e.g. `100` (invalid length), `200` ' +
            '(invalid check digit), `300` (WMI not found).',
        example: '300',
    })
    code: string;

    @ApiProperty({
        enum: ['validation', 'structure', 'lookup', 'pattern', 'database'],
    })
    category: string;

    @ApiProperty({ enum: ['warning', 'error', 'fatal'] })
    severity: string;

    @ApiProperty()
    message: string;

    @ApiPropertyOptional({
        type: [Number],
        description: 'VIN positions this error covers.',
    })
    positions?: number[];

    @ApiPropertyOptional()
    details?: string;

    @ApiPropertyOptional({
        description: 'Validation errors only: the expected value.',
    })
    expected?: string;

    @ApiPropertyOptional({
        description: 'Validation errors only: the actual value.',
    })
    actual?: string;

    @ApiPropertyOptional({
        description: 'Lookup errors only: the key that was searched for.',
    })
    searchKey?: string;

    @ApiPropertyOptional({
        description: 'Lookup errors only: what kind of lookup ran.',
    })
    searchType?: string;
}

export class VinDecodeResultDto {
    @ApiProperty({ description: 'The VIN that was decoded, as submitted.' })
    vin: string;

    @ApiProperty({
        description:
            'False when the VIN failed structural validation (length, check ' +
            'digit) or its WMI is unknown — see `errors` for why. `components` ' +
            'may still carry partial data in that case.',
    })
    valid: boolean;

    @ApiProperty({ type: VinComponentsDto })
    components: VinComponentsDto;

    @ApiProperty({ type: [DecodeErrorDto] })
    errors: DecodeErrorDto[];
}
