import { ApiProperty } from '@nestjs/swagger';

/**
 * The failure body of every 4xx/5xx this API returns.
 *
 * Nothing rewrites it — there is no custom exception filter — so this is Nest's
 * built-in `HttpException` shape verbatim. It exists as a class purely so the
 * document has an error schema to point at; nothing constructs it.
 *
 * The one shape worth care is `message`: a plain string for exceptions thrown by
 * hand (`throw new BadRequestException('Unknown organisation.')`) and an array
 * of strings when the global ValidationPipe rejects a body (one entry per failed
 * constraint). Clients must handle both — narrow with `Array.isArray` rather
 * than assuming either.
 */
export class ApiErrorDto {
    @ApiProperty({
        description: 'Mirrors the HTTP status code of the response.',
        example: 400,
    })
    statusCode: number;

    @ApiProperty({
        oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
        ],
        description:
            'A single message for a hand-thrown exception, or one entry per ' +
            'failed constraint when request validation is what rejected the call.',
        example: 'Missing X-Organisation-Slug header',
    })
    message: string | string[];

    @ApiProperty({
        description: 'HTTP reason phrase for the status code.',
        example: 'Bad Request',
    })
    error: string;
}
