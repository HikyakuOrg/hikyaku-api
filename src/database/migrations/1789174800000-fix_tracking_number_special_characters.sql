-- HIK-68: generate_tracking_number() encoded random bytes as base64, whose
-- alphabet includes '+', '/' and '=' — characters with special meaning in
-- URLs. A tracking number containing '+' (e.g. "2609036BNWeZFqY+Q") breaks
-- the web dashboard's package detail route because '+' decodes to a space
-- in a URL path segment, so the lookup against the real tracking number
-- fails ("Package not found").
--
-- Switch the random suffix to an alphanumeric-only alphabet (0-9, A-Z, a-z)
-- so every future tracking number is URL-safe without encoding. Same length
-- and same YYMMDD prefix as before, so nothing downstream that parses the
-- format needs to change. Existing tracking numbers already containing
-- special characters are untouched by this migration; the web dashboard
-- fix for those is HIK-68's other half.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION "public"."generate_tracking_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  alphabet CONSTANT text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  random_bytes bytea := gen_random_bytes(11);
  suffix text := '';
  i integer;
BEGIN
  FOR i IN 0..10 LOOP
    suffix := suffix || substr(alphabet, (get_byte(random_bytes, i) % length(alphabet)) + 1, 1);
  END LOOP;
  RETURN to_char(clock_timestamp(), 'YYMMDD') || suffix;
END;
$$;
