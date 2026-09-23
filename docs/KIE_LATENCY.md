# Kie.ai latency in HeliosGen

Reference for operators and developers. Official Kie docs: [docs.kie.ai](https://docs.kie.ai/).

## What Kie guarantees

- Every create returns a **`taskId`**; HTTP 200 means **queued**, not finished.
- States: `waiting` → `queuing` → `generating` → `success` | `fail` ([recordInfo](https://docs.kie.ai/market/common/get-task-detail)).
- Video often takes **minutes** (Veo docs: ~2–5 min typical for fast tier; heavy queue can be much longer).
- **~20 new tasks / 10 seconds** per account; 429 responses are **not** queued.

## HeliosGen integration map

| Path | Kie usage |
|------|-----------|
| Gallery / nodes image gen | `POST /api/v1/jobs/createTask` + optional `callBackUrl` |
| Standard video | `createTask` or `POST /api/v1/veo/generate` |
| Speech / talking | Synthetic `talk-*` id; **sequential** Kie sub-tasks (TTS → avatar or Seedance) via [`lib/talkingPipeline.ts`](../lib/talkingPipeline.ts) |
| Prompt / assistant LLM | Sync chat on `api.kie.ai` ([`app/api/assistant/route.ts`](../app/api/assistant/route.ts)) — same credits, different queue |
| Completion | Webhook [`/api/callback`](../app/api/callback/route.ts) + poll [`/api/job-status`](../app/api/job-status/route.ts) + [`lib/kieJobSync.ts`](../lib/kieJobSync.ts) |

## SQL to run (in order)

After `supabase-setup.sql` and `supabase-folders.sql`:

1. [`supabase-realtime.sql`](../supabase-realtime.sql)
2. [`supabase-progress-phase.sql`](../supabase-progress-phase.sql)
3. [`supabase-pipeline-meta.sql`](../supabase-pipeline-meta.sql) — talking sub-task state

## Ops checklist

1. Set **`CALLBACK_BASE_URL`** to public HTTPS (production origin). Kie must reach `{origin}/api/callback` without Vercel Deployment Protection blocking anonymous POSTs.
2. Run `node scripts/smoke-test.mjs` — sections A2/D1 cover callback URL and host reachability.
3. Confirm Vercel logs show `[callback]` for standard video jobs after completion.
4. Per-user **kie.ai API key** in Settings (no shared `KIE_API_KEY` on cloud).

## Diagnose a slow job

While signed in, call:

```http
GET /api/job-diagnostic?taskId={taskId}
```

Response compares:

- **helios.progress_phase** — UI label source (`creating-voice`, `lip-sync`, `queued`, …)
- **kie.state** — live Kie queue/generating state for the real Kie id (or active talking sub-task)

For `talk-*` jobs, `pipeline_meta.activeKieTaskId` is the Kie id currently in flight.

## Baseline comparison (product)

Use the same short prompt to separate **Kie queue** from **multi-step speech**:

| Test | Model / mode | Expect |
|------|----------------|--------|
| A | Video → **Veo 3 Fast**, text only, ~5s | Single Kie task; often fastest video path |
| B | Video → **Speech** on, same topic | TTS + Seedance (or avatar with face+audio); **sum of two Kie waits** |

If A is slow in `waiting`, the bottleneck is Kie/upstream. If A is fine and B is slow, pipeline depth is expected.

## UI labels

| Label | Meaning |
|-------|---------|
| Waiting on provider… | Kie state `waiting` / `queuing` (or stale phase before sync) |
| Creating voice… | Speech: Gemini TTS sub-task |
| Lip-sync… | Kling AI Avatar sub-task |
| Generating… | Seedance (or generic Kie `generating`) |
| Saving… | R2 mirror / mux after Kie success |

Long-run hint after 5 min on speech: see [`lib/genProgress.ts`](../lib/genProgress.ts) `longRunHint`.

## Further reading

- [`docs/HANDOVER.md`](HANDOVER.md) §6–7 troubleshooting and callbacks
- Kie getting started: rate limits and async model
