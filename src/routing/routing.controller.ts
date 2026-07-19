import {
    BadRequestException,
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Post,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiHeader,
    ApiOkResponse,
    ApiTags,
} from '@nestjs/swagger';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ValhallaService } from 'src/valhalla/valhalla.service';
import { RouteRequestDto } from './dto/route-request.dto';
import { RoutePreviewDto } from './dto/route-preview.dto';

/**
 * Public routing endpoint. Unauthenticated by design — it is called both from
 * the dashboard and from the public booking/tracking site — so there is NO
 * PermissionGuard. The active org is resolved from the x-org-slug header that
 * middleware forwards (validated for parity with the other public endpoints,
 * even though routing geometry is org-agnostic). The frontend never talks to
 * the routing engine directly; this hides it behind a normalised RoutePreview.
 */
@ApiTags('routing')
@Controller('api/v1/routing')
export class RoutingController {
    constructor(
        private readonly valhalla: ValhallaService,
        private readonly orgs: OrganisationsService,
    ) {}

    @Post('route')
    @HttpCode(HttpStatus.OK)
    @ApiHeader({
        name: 'x-org-slug',
        required: true,
        description: 'Slug of the active organisation.',
    })
    @ApiOkResponse({ type: RoutePreviewDto })
    @ApiBadRequestResponse({ description: 'Unknown or missing organisation.' })
    async route(
        @Body() dto: RouteRequestDto,
        @Headers('x-org-slug') slug?: string,
    ): Promise<RoutePreviewDto> {
        await this.requireOrg(slug);
        return this.valhalla.route(dto.profile, dto.coordinates);
    }

    private async requireOrg(slug?: string): Promise<string> {
        if (slug) {
            const org = await this.orgs.findBySlug(slug);
            if (org?.id) return org.id;
        }
        throw new BadRequestException('Unknown or missing organisation.');
    }
}
