-- Phase 9.3: lock down function search_path. Functions whose
-- search_path is settable per-session are subject to a privilege
-- escalation pattern where an attacker who can SET search_path could
-- redirect a SECURITY DEFINER call to a malicious function. None of
-- our functions are SECURITY DEFINER today, but Supabase flags this
-- as a warning so it stays clean.
--
-- We don't move the vector extension out of public — the embedded
-- column types reference public.vector and a schema move would
-- require updating every column type, defeating the cleanup.

ALTER FUNCTION public.suspend_expired_tenants() SET search_path = pg_catalog, public;
ALTER FUNCTION public.search_chunks_in_course(uuid, vector, integer, integer) SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public;
