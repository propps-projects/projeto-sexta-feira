-- Phase 9.1: Defense-in-depth. RLS enabled on every public table.
-- service_role bypasses RLS by Postgres design (it's a superuser-ish role).
-- We add a deny-all policy for anon + authenticated so even if the anon
-- public key leaks (e.g. someone copies it from Supabase Studio screenshots
-- of dashboards or it gets committed), no rows are exposed.
--
-- All our runtime DB access goes through SUPABASE_SERVICE_ROLE_KEY via
-- PostgREST (lib/db-api.ts), so this change has zero behavioral impact
-- on the application — it only eliminates the security advisory.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('DROP POLICY IF EXISTS deny_anon ON public.%I', r.tablename);
    EXECUTE format('DROP POLICY IF EXISTS deny_authenticated ON public.%I', r.tablename);
    EXECUTE format('CREATE POLICY deny_anon ON public.%I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)', r.tablename);
    EXECUTE format('CREATE POLICY deny_authenticated ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false)', r.tablename);
  END LOOP;
END$$;
