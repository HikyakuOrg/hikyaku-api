
-- Resync the identity sequence before inserting. Environments bootstrapped
-- from infra/db/schema.sql + seed.sql (rather than via migration replay from
-- an empty DB) get their initial package_status rows from seed.sql's
-- explicit-id INSERT, which never calls nextval() — so package_status_id_seq
-- is left at its start position while rows already occupy those ids. A plain
-- INSERT here would then collide with "package_status_pkey" on whatever id
-- the sequence thinks is still free. GREATEST(...) only ever moves the
-- sequence forward, so this is a no-op on databases where it was already
-- correctly in sync (i.e. seeded by migration replay from the start).
SELECT setval(
    pg_get_serial_sequence('public.package_status', 'id'),
    GREATEST(
        (SELECT COALESCE(MAX(id), 0) FROM public.package_status),
        (SELECT last_value FROM public.package_status_id_seq)
    ),
    true
);

INSERT into package_status (status, enums) values ('Onboard for Delivery', 'ONBOARD_FOR_DELIVERY');