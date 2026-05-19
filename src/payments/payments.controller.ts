import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PayServiceFeeDto } from './dto/pay-service-fee.dto';
import { CheckoutResult, PaymentsService } from './payments.service';

@ApiTags('service-fees')
@Controller('api/v1/service-fees')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) {}

    @Post('pay')
    @HttpCode(HttpStatus.OK)
    @ApiBody({ type: PayServiceFeeDto })
    @ApiResponse({ status: 200, description: 'Stripe Checkout session created' })
    @ApiResponse({ status: 400, description: 'Validation error / invalid phone' })
    @ApiResponse({ status: 404, description: 'Service rate not found' })
    @ApiResponse({ status: 503, description: 'Distance calculation unavailable' })
    async pay(@Body() dto: PayServiceFeeDto): Promise<CheckoutResult> {
        return this.paymentsService.createCheckoutSession(dto);
    }
}
