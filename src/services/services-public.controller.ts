import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiBadRequest } from 'src/common/swagger/api-errors.decorator';
import { ApiOrgSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ServicesService } from './services.service';
import { BookingService } from './booking.service';
import { QuoteBookingDto } from './dto/quote-booking.dto';
import { PayBookingDto } from './dto/pay-booking.dto';
import { ServiceCatalogDto } from './dto/service-catalog.dto';
import { CheckoutResultDto, QuoteResultDto } from './dto/booking-result.dto';

/**
 * Public catalog + booking endpoints. Unauthenticated by design — the booking
 * page (<slug>.hikyaku.org/booking) is open to anyone — so there is NO
 * PermissionGuard, and deliberately no @ApiBearerAuth: a generated client must
 * not attach a token here. The active org is resolved from the x-org-slug header
 * that middleware forwards. Same base path as the admin controller; the route
 * sets don't collide.
 */
@ApiTags('services')
@Controller('api/v1/services')
export class ServicesPublicController {
    constructor(
        private readonly services: ServicesService,
        private readonly booking: BookingService,
        private readonly orgs: OrganisationsService,
    ) {}

    @Get('catalog')
    @ApiOperation({
        summary: 'The organisation’s bookable services and their add-ons.',
        description:
            'Reads live from the organisation’s Stripe products. Answers with an ' +
            'empty `services` array — not an error — when the slug is missing or ' +
            'the organisation has not connected a Stripe account, so the booking ' +
            'page can render an empty state.',
    })
    @ApiOrgSlugHeader({ required: false })
    @ApiOkResponse({ type: ServiceCatalogDto })
    async catalog(@Headers('x-org-slug') slug?: string): Promise<ServiceCatalogDto> {
        const organisationId = await this.resolveOrg(slug);
        if (!organisationId) return { services: [] };
        return this.services.getCatalog(organisationId);
    }

    @Post('quote')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Price a booking without charging for it.',
        description:
            'Recomputes the price server-side from the catalog and the submitted ' +
            'booking. Distance-priced items trigger a live routing call, so this ' +
            'is not a free operation.',
    })
    @ApiOrgSlugHeader()
    @ApiOkResponse({ type: QuoteResultDto })
    @ApiBadRequest(
        'Unknown or missing organisation, an add-on that does not belong to the ' +
            'chosen service, the organisation has not finished payment setup, or ' +
            'the body failed validation.',
    )
    async quote(
        @Body() dto: QuoteBookingDto,
        @Headers('x-org-slug') slug?: string,
    ): Promise<QuoteResultDto> {
        return this.booking.quote(await this.requireOrg(slug), dto);
    }

    @Post('pay')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Open a Stripe Checkout session for a booking.',
        description:
            'Re-prices the booking authoritatively (the client-supplied amount is ' +
            'never trusted), records a `pending` payment, and returns a hosted ' +
            'Checkout URL to redirect to. The customer and package are created ' +
            'afterwards by the Stripe webhook, once payment settles.',
    })
    @ApiOrgSlugHeader()
    @ApiOkResponse({ type: CheckoutResultDto })
    @ApiBadRequest(
        'Unknown or missing organisation, an add-on that does not belong to the ' +
            'chosen service, a sender or recipient phone number that is not valid ' +
            'E.164, or the body failed validation.',
    )
    async pay(
        @Body() dto: PayBookingDto,
        @Headers('x-org-slug') slug?: string,
    ): Promise<CheckoutResultDto> {
        return this.booking.pay(await this.requireOrg(slug), dto);
    }

    private async resolveOrg(slug?: string): Promise<string | null> {
        if (!slug) return null;
        const org = await this.orgs.findBySlug(slug);
        return org?.id ?? null;
    }

    private async requireOrg(slug?: string): Promise<string> {
        const organisationId = await this.resolveOrg(slug);
        if (!organisationId) {
            throw new BadRequestException('Unknown or missing organisation.');
        }
        return organisationId;
    }
}
