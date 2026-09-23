-- Live job phase for gallery progress (talking pipeline + Kie sync). Safe to re-run.
alter table public.generations add column if not exists progress_phase text;
