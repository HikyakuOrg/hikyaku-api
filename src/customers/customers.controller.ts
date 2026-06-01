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
import { ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { CustomersService } from './customers.service';
import { UpsertCustomerDto } from './dto/upsert-customer.dto';
import { BatchByDbIdsDto, BatchByStripeIdsDto } from './dto/batch-customers.dto';

@ApiTags('customers')
@Controller('api/v1/customers')
@UseGuards(PermissionGuard)
export class CustomersController {
    constructor(private readonly customers: CustomersService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('customers.add')
    @ApiBody({ type: UpsertCustomerDto })
    create(
        @Body() dto: UpsertCustomerDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.createCustomer(req.organisationId, dto);
    }

    @Put(':id')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('customers.update')
    @ApiBody({ type: UpsertCustomerDto })
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpsertCustomerDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.updateCustomer(req.organisationId, id, dto);
    }

    @Get()
    @RequirePermission('customers.view')
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    @ApiResponse({ status: 200, description: 'Paginated customer list' })
    list(
        @Query('page') page = '1',
        @Query('pageSize') pageSize = '10',
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.listCustomers(req.organisationId, Number(page), Number(pageSize));
    }

    @Get('search')
    @RequirePermission('customers.view')
    @ApiQuery({ name: 'q', required: true, type: String })
    @ApiResponse({ status: 200, description: 'Customer search results' })
    search(
        @Query('q') q: string,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.searchCustomers(req.organisationId, q ?? '');
    }

    @Get(':id')
    @RequirePermission('customers.view')
    @ApiResponse({ status: 200, description: 'Single customer' })
    getOne(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.getCustomer(req.organisationId, id);
    }

    @Post('by-ids')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('customers.view')
    @ApiBody({ type: BatchByDbIdsDto })
    @ApiResponse({ status: 200, description: 'Customers by DB IDs' })
    getByIds(
        @Body() dto: BatchByDbIdsDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.getCustomersByDbIds(req.organisationId, dto.ids);
    }

    @Post('by-stripe-ids')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('customers.view')
    @ApiBody({ type: BatchByStripeIdsDto })
    @ApiResponse({ status: 200, description: 'Customers by Stripe IDs' })
    getByStripeIds(
        @Body() dto: BatchByStripeIdsDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.customers.getCustomersByStripeIds(req.organisationId, dto.stripeIds);
    }
}
