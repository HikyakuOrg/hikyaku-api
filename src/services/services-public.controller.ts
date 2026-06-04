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
import { ApiTags } from '@nestjs/swagger';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ServicesService } from './services.service';
import { BookingService } from './booking.service';
import { QuoteBookingDto } from './dto/quote-booking.dto';
import { PayBookingDto } from './dto/pay-booking.dto';

/**
 * Public catalog + booking endpoints. Unauthenticated by design — the booking
 * page (<slug>.hikyaku.org/booking) is open to anyone — so there is NO
 * PermissionGuard. The active org is resolved from the x-org-slug header that
 * middleware forwards. Same base path as the admin controller; the route sets
 * don't collide.
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
    async catalog(@Headers('x-org-slug') slug?: string) {
        const organisationId = await this.resolveOrg(slug);
        if (!organisationId) return { services: [] };
        return this.services.getCatalog(organisationId);
    }

    @Post('quote')
    @HttpCode(HttpStatus.OK)
    async quote(
        @Body() dto: QuoteBookingDto,
        @Headers('x-org-slug') slug?: string,
    ) {
        return this.booking.quote(await this.requireOrg(slug), dto);
    }

    @Post('pay')
    @HttpCode(HttpStatus.OK)
    async pay(@Body() dto: PayBookingDto, @Headers('x-org-slug') slug?: string) {
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
