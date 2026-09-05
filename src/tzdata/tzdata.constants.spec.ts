import { redactSecrets } from './tzdata.constants';

describe('redactSecrets', () => {
    it("redacts a libpq password='...' value", () => {
        const input =
            "ogr2ogr -f PostgreSQL PG:host='x' port='5432' password='l>{KHeFPid)S4jpGBq97' sslmode='require'";
        const out = redactSecrets(input);

        expect(out).not.toContain('l>{KHeFPid)S4jpGBq97');
        expect(out).toContain("password='***'");
        expect(out).toContain("host='x'"); // unrelated fields untouched
    });

    it('redacts a postgresql:// URL password', () => {
        const input =
            'connection failed: postgresql://postgres.abc:l>{KHeFPid)S4jpGBq97@host:5432/postgres';
        const out = redactSecrets(input);

        expect(out).not.toContain('l>{KHeFPid)S4jpGBq97');
        expect(out).toBe(
            'connection failed: postgresql://postgres.abc:***@host:5432/postgres',
        );
    });

    it('leaves text with no credentials untouched', () => {
        const input =
            'ERROR: null value in column "id" of relation "timezone" violates not-null constraint';
        expect(redactSecrets(input)).toBe(input);
    });
});
