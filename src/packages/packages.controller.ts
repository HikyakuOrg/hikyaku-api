import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    NotImplementedException,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import {
    BulkCreatePackagesDto,
    CreatePackageDto,
} from './dto/create-package.dto';
import {
    BulkCreatePackagesResultDto,
    CreatePackageResultDto,
} from './dto/package-result.dto';

@ApiTags('packages')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/packages')
@UseGuards(PermissionGuard)
export class PackagesController {
    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('packages.add')
    @ApiBody({ type: CreatePackageDto })
    @ApiResponse({
        status: 201,
        description:
            'Package created. `assignment.outcome` says whether it reached a ' +
            'shift — creation and assignment are separate transactions, so a ' +
            'package that could not be assigned is still created and returned ' +
            'with outcome `deferred`.',
        type: CreatePackageResultDto,
    })
    @ApiResponse({
        status: 200,
        description:
            'Idempotent replay: a package with this tracking number and an ' +
            'identical payload already exists, and is returned unchanged.',
        type: CreatePackageResultDto,
    })
    @ApiResponse({
        status: 409,
        description:
            'The tracking number belongs to a different package. Rows in another ' +
            'organisation are reported as unknown (400), never as a conflict.',
        type: ApiErrorDto,
    })
    create(
        @Body() dto: CreatePackageDto,
        @Req() req: Request & { organisationId: string; user: { id: string } },
    ): Promise<CreatePackageResultDto> {
        void dto;
        void req;
        throw new NotImplementedException();
    }

    @Post('bulk')
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('packages.add')
    @ApiBody({ type: BulkCreatePackagesDto })
    @ApiResponse({
        status: 201,
        description:
            'Index-aligned per-package results. Assignment takes the per-warehouse ' +
            'lock once for the whole batch and emits a single replan, so importing ' +
            'N packages costs one lock acquisition rather than N. A failed entry ' +
            'carries `error` and does not fail the batch.',
        type: BulkCreatePackagesResultDto,
    })
    createBulk(
        @Body() dto: BulkCreatePackagesDto,
        @Req() req: Request & { organisationId: string; user: { id: string } },
    ): Promise<BulkCreatePackagesResultDto> {
        void dto;
        void req;
        throw new NotImplementedException();
    }

    @Post(':id/reassign')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('packages.update')
    @ApiResponse({
        status: 200,
        description:
            'Unassigns the package and runs assignment again — the path for a ' +
            'deadline that changed after creation.',
        type: CreatePackageResultDto,
    })
    @ApiResponse({
        status: 409,
        description:
            'The package is already loaded or in transit and cannot be moved.',
        type: ApiErrorDto,
    })
    reassign(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<CreatePackageResultDto> {
        void id;
        void req;
        throw new NotImplementedException();
    }
}
