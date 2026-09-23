-- Talking pipeline sub-task state (async Kie jobs + callbacks). Safe to re-run.
alter table public.generations add column if not exists pipeline_meta jsonb;
