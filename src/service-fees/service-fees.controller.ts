import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CalculateServiceFeeDto } from './dto/calculate-service-fee.dto';
import { ServiceFeeResponseDto } from './dto/service-fee-response.dto';
import { ServiceFeesService } from './service-fees.service';

@ApiTags('service-fees')
@Controller('api/v1/service-fees')
export class ServiceFeesController {
    constructor(private readonly serviceFeesService: ServiceFeesService) {}

    @Post('calculate')
    @HttpCode(HttpStatus.OK)
    @ApiBody({ type: CalculateServiceFeeDto })
    @ApiResponse({ status: 200, description: 'Cost breakdown for the shipment' })
    @ApiResponse({ status: 400, description: 'Validation error' })
    @ApiResponse({ status: 404, description: 'Service rate not found' })
    @ApiResponse({ status: 503, description: 'Distance calculation unavailable' })
    async calculate(@Body() dto: CalculateServiceFeeDto): Promise<ServiceFeeResponseDto> {
        return this.serviceFeesService.calculate(dto);
    }
}
