/**
 * Node's IncomingHttpHeaders allows a header to arrive as a string array (an
 * HTTP-permitted way to send a repeated header). Every header this codebase
 * reads is meant to be single-valued, so callers just want the first value.
 */
export function headerValue(
    value: string | string[] | undefined,
): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}
