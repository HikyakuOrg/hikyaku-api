import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HealthDto } from './dto/health.dto';

/**
 * Liveness probe for uptime monitors (Better Stack etc). Deliberately shallow
 * and unauthenticated: it only proves the process can accept and answer a
 * request, so a monitor's pass/fail can key off the HTTP status code alone.
 * It does not check Postgres, pgmq, VROOM or Valhalla.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
    @Get()
    @ApiOkResponse({ type: HealthDto })
    check(): HealthDto {
        return { status: 'ok' };
    }
}
