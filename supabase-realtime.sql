-- Run after supabase-setup.sql. Enables Realtime on generation rows for instant UI updates.
alter publication supabase_realtime add table public.generations;
