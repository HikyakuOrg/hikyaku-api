import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import {
    ApiGuardErrors,
    ApiNotFound,
} from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { CustomersService } from './customers.service';
import { UpsertCustomerDto } from './dto/upsert-customer.dto';
import {
    BatchByDbIdsDto,
    BatchByStripeIdsDto,
} from './dto/batch-customers.dto';
import { CustomerDto, PaginatedCustomersDto } from './dto/customer.dto';

@ApiTags('customers')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/customers')
@UseGuards(PermissionGuard)
export class CustomersController {
    constructor(private readonly customers: CustomersService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('customers.add')
    @ApiOperation({
        summary: 'Create a customer.',
        description:
            'The database is authoritative. When the organisation has payments ' +
            'enabled a matching Stripe customer is created best-effort — a Stripe ' +
            'failure is logged and leaves `stripe_customer_id` null rather than ' +
            'failing the request.',
    })
    @ApiBody({ type: UpsertCustomerDto })
    @ApiCreatedResponse({ type: CustomerDto })
    create(
        @Body() dto: UpsertCustomerDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<CustomerDto> {
        return this.customers.createCustomer(req.organisationId, dto);
    }

    @Put(':id')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('customers.update')
    @ApiOperation({
        summary: 'Replace a customer.',
        description:
            'A full replacement, not a patch — every field in the body is written. ' +
            'The linked Stripe customer is updated best-effort where one exists.',
    })
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ type: UpsertCustomerDto })
    @ApiOkResponse({ type: CustomerDto })
    @ApiNotFound('No customer with this id in the organisation.')
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpsertCustomerDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<CustomerDto> {
        return this.customers.updateCustomer(req.organisationId, id, dto);
    }

    @Get()
    @RequirePermission('customers.view')
    @ApiOperation({
        summary: 'List customers, newest first.',
        description:
            'Both query params are coerced with `Number()` and are 1-based. Out of ' +
            'range values are not rejected — a page past the end yields an empty ' +
            '`data` array with `total` still populated.',
    })
    @ApiQuery({
        name: 'page',
        required: false,
        type: Number,
        description: '1-based page number. Defaults to 1.',
        example: 1,
    })
    @ApiQuery({
        name: 'pageSize',
        required: false,
        type: Number,
        description: 'Rows per page. Defaults to 10.',
        example: 10,
    })
    @ApiOkResponse({ type: PaginatedCustomersDto })
    list(
        @Query('page') page = '1',
        @Query('pageSize') pageSize = '10',
        @Req() req: Request & { organisationId: string },
    ): Promise<PaginatedCustomersDto> {
        return this.customers.listCustomers(
            req.organisationId,
            Number(page),
            Number(pageSize),
        );
    }

    @Get('search')
    @RequirePermission('customers.view')
    @ApiOperation({
        summary: 'Search customers by name, phone or email.',
        description:
            'Case-insensitive substring match across all three columns, newest ' +
            'first, capped at 20 results. A query shorter than two characters ' +
            'returns an empty array rather than an error.',
    })
    @ApiQuery({
        name: 'q',
        required: true,
        type: String,
        description:
            'Search term. Needs at least two characters to match anything.',
    })
    @ApiOkResponse({ type: [CustomerDto] })
    search(
        @Query('q') q: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<CustomerDto[]> {
        return this.customers.searchCustomers(req.organisationId, q ?? '');
    }

    @Get(':id')
    @RequirePermission('customers.view')
    @ApiOperation({ summary: 'Fetch one customer by id.' })
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ type: CustomerDto })
    @ApiNotFound('No customer with this id in the organisation.')
    getOne(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<CustomerDto> {
        return this.customers.getCustomer(req.organisationId, id);
    }

    @Post('by-ids')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('customers.view')
    @ApiOperation({
        summary: 'Fetch several customers by database id.',
        description:
            'A POST because the id list goes in the body. Ids that do not match ' +
            'are skipped silently, so the result may be shorter than the request ' +
            'and is not order-aligned with it.',
    })
    @ApiBody({ type: BatchByDbIdsDto })
    @ApiOkResponse({ type: [CustomerDto] })
    getByIds(
        @Body() dto: BatchByDbIdsDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<CustomerDto[]> {
        return this.customers.getCustomersByDbIds(req.organisationId, dto.ids);
    }

    @Post('by-stripe-ids')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('customers.view')
    @ApiOperation({
        summary: 'Fetch several customers by Stripe customer id.',
        description:
            'Same semantics as `by-ids`, keyed on `stripe_customer_id`. Customers ' +
            'not yet synced to Stripe can never match.',
    })
    @ApiBody({ type: BatchByStripeIdsDto })
    @ApiOkResponse({ type: [CustomerDto] })
    getByStripeIds(
        @Body() dto: BatchByStripeIdsDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<CustomerDto[]> {
        return this.customers.getCustomersByStripeIds(
            req.organisationId,
            dto.stripeIds,
        );
    }
}
