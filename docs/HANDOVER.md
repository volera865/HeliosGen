# HeliosGen Cloud (Vercel) Handover

Operational notes for deploying and operating the Cloud Mode build. Contains **no secrets** and **no real project URLs**.

## 1. Environment variables

### Required on Vercel (names only)

| Name | Role |
|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase admin client |
| `R2_ACCOUNT_ID` | Cloudflare R2 account |
| `R2_ACCESS_KEY_ID` | R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret |
| `R2_BUCKET_NAME` | R2 bucket name |
| `R2_PUBLIC_URL` | Public CDN base for uploaded objects |
| `CALLBACK_BASE_URL` | Public site origin used to build kie.ai callbacks (`…/api/callback`) |

### Optional / situational

| Name | Role |
|------|------|
| `NEXT_PUBLIC_APP_URL` | Used as Referer for some proxy fetches |
| `NEXT_PUBLIC_DEBUG` | Shows debug UI in Settings when `"true"` |
| `VERCEL` | Set automatically by Vercel; forces guest mode off |

### Must NOT be set on Vercel

These break the security / cloud assumptions of this build:

| Name | Why |
|------|-----|
| `GUEST_MODE` | Local-disk guest writes; forced off when `VERCEL` is set, but do not set it |
| `NEXT_PUBLIC_GUEST_MODE` | Forced to `"false"` at build time on Vercel via `next.config.ts`; do not set `"true"` |
| `NEXT_PUBLIC_DEMO_MODE` | Opens auth walls / demo shortcuts; leave unset |
| `KIE_API_KEY` | Shared keys are retired; each user stores their own key |
| `KIE_API_TOKEN` | Shared-key fallback removed from generate-video |
| `AZURE_API_KEY` | Prefer per-user keys in Settings; shared env key is a footgun on a multi-tenant host |
| `REPLICATE_API_TOKEN` | Legacy `generate-image` route is retired (410) |
| `CODEX_HOME` | Codex CLI is host-only; unavailable on Vercel (501) |

Users add their **own** kie.ai (and optional Azure) keys in Settings after invite sign-in.

## 2. SQL to run (in order)

1. `supabase-setup.sql` — core tables (`generations`, uploads, user settings, etc.)
2. `supabase-folders.sql` — folders / folder_items

Run both in the Supabase SQL editor against the project used by the Vercel env vars.

## 3. Supabase dashboard settings (auth)

### Site URL & redirects

- **Site URL**: your Vercel **Production** origin (no trailing path).  
  Example for this deployment: `https://higgsfield-n7pq.vercel.app`  
  Do **not** use a `*-git-main-*` preview URL — those are behind Vercel SSO (“Authentication Required”) and invitees cannot open them.
- **Redirect URLs**: include  
  `{SiteURL}/api/auth/callback`  
  Example: `https://higgsfield-n7pq.vercel.app/api/auth/callback`  
  Optionally keep preview callbacks for internal testing only.

### Disable public sign-ups

- Authentication → Providers → Email (or Sign In / Providers): **disable** “Allow new users to sign up”.
- Access is invite-only; the UI no longer offers a sign-up tab.

### Email templates

Use **token_hash** links that hit the app callback (not the default Supabase `{{ .ConfirmationURL }}` alone).

**Invite user** — Confirmation URL / link body should use:

```text
{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=invite
```

**Reset Password** — Confirmation URL / link body should use:

```text
{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=recovery
```

Example invite email body:

```html
<p>You have been invited to HeliosGen.</p>
<p><a href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=invite">Accept invitation</a></p>
```

Example reset email body:

```html
<p>Reset your HeliosGen password.</p>
<p><a href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=recovery">Reset password</a></p>
```

After verify, the callback redirects with `#type=recovery` so `components/AuthEvents.tsx` opens the set-password modal. Hash `#type=invite` is also handled (default Supabase invite fragments).

### Vercel (invite landing)

- Production domain must be **public** (no Deployment Protection SSO for strangers).
- Set `CALLBACK_BASE_URL=https://higgsfield-n7pq.vercel.app` (or your custom production domain) and redeploy.
- Never set Supabase Site URL to a protected Preview deployment URL.

### Other dashboard checks

- Confirm Email provider is enabled for invites / recovery.
- OTP / link expiry long enough for invitees to accept.
- No need to expose the service role key in the browser.

### Invite re-test checklist

1. Site URL = Production (`https://higgsfield-n7pq.vercel.app`).
2. Invite template uses `token_hash` + `type=invite` as above.
3. Re-invite the user (or delete and invite again).
4. Open the email link in **incognito** (not logged into Vercel).
5. Expect: land on Production → **Set password** modal → then sign in. No Vercel “Authentication Required” page.

## 4. Adding a new video model (`lib/modelConfig.ts`)

Models are declared in `VIDEO_MODELS`. The UI and `/api/generate-video` read this file; you usually do not touch routes.

Worked example — existing **Kling 3.0** entry (copy and adapt):

```572:600:lib/modelConfig.ts
    id: "kling-3.0",
    apiId: "kling-3.0/video",
    name: "Kling 3.0",
    provider: "Kling",
    ratios: ["16:9", "9:16", "1:1"],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    defaultRatio: "9:16",
    handles: ["prompt", "startFrame", "endFrame", "resource"],
    sound: true,
    modes: [
      { value: "std", label: "720p" },
      { value: "pro", label: "1080p" },
      { value: "4K",  label: "4K"   },
    ],
    defaultMode: "pro",
    apiInput: {
      aspectRatioKey: "aspect_ratio",
      durationKey: "duration",
      durationAsString: true,
      durationMin: 3,
      durationMax: 15,
      modeKey: "mode",
      soundKey: "sound",
      useImageUrls: true,
      useKlingElements: true,
      promptMaxLength: 2500,
      extra: { multi_shots: false, multi_prompt: [], kling_elements: [] },
    },
```

Steps:

1. Copy a similar model block in `VIDEO_MODELS`.
2. Set unique `id` (app) and `apiId` (kie.ai).
3. Adjust `handles`, `durations`, `ratios`, and `apiInput` keys to match kie.ai’s payload.
4. Redeploy. No schema change required.

Header guidance in the same file (lines 1–6) says: add the entry — the UI and API routes pick it up automatically.

### Adding a model whose payload differs (Kling AI Avatar)

When kie.ai expects a different `input` shape (not duration/aspect/frames), three places change:

1. **Model entry** — empty `ratios`/`durations`, `sound: false`, `handles: ["prompt", "startFrame", "audioRef"]`, `requiredHandles`, and `apiInput.useKlingAiAvatar` ([`lib/modelConfig.ts`](lib/modelConfig.ts) 632–671).

```632:651:lib/modelConfig.ts
  // IDs per docs.kie.ai/market/kling/ai-avatar-standard and ai-avatar-pro; input is image_url, audio_url, prompt only.
  {
    id: "kling-ai-avatar-standard",
    apiId: "kling/ai-avatar-standard",
    name: "Kling AI Avatar (Standard)",
    ...
    apiInput: {
      durationMin: 0,
      durationMax: 0,
      useKlingAiAvatar: true,
    },
  },
```

2. **Payload branch** — early branch in [`app/api/generate-video/route.ts`](app/api/generate-video/route.ts) (94–116) sends only `{ image_url, audio_url, prompt }` and returns 400 if face or audio is missing / not https.

3. **UI** — gallery Face/Audio slots + generate gating ([`app/gallery/page.tsx`](app/gallery/page.tsx) ~2634–2639, ~3893–3935); video node handle labels + hint ([`components/nodes/VideoGeneratorNode.tsx`](components/nodes/VideoGeneratorNode.tsx) 578–598, 1212–1217). Duration/aspect/sound stay hidden because those arrays are empty / `sound` is false.

Note: the workflow canvas has no audio input node yet — gallery upload is the supported path for the audio file.

## 5. Features unavailable on Vercel

| Feature | Behaviour |
|---------|-----------|
| Trim video (`/api/trim-video`) | HTTP **501** `{ "error": "Not available in this deployment" }` |
| Extract frame (`/api/extract-frame`) | HTTP **501** (same body) |
| Codex login / status | HTTP **501** (same body) |
| Guest / local-disk mode | Forced off when `VERCEL` is set |
| Legacy Replicate `generate-image` | HTTP **410** `{ "error": "Removed" }` |

### Upload size limits

- Vercel request bodies are roughly **4.5 MB**. Proxy routes that still accept bodies (`upload-asset`, `upload-video`, `fetch-url`) stay capped at **~4 MB**.
- **Cloud (production) user uploads** use direct-to-R2: browser → `POST /api/upload-presign` → `PUT` to R2 → `POST /api/upload-complete`. App cap is **100 MB**. File bytes never enter a Vercel function.
- Guest / local mode still uses `POST /api/upload-asset` (4 MB) because files land on local disk.
- JSON data-URL uploads (`upload-to-r2`): capped at **~3 MB decoded** (small/base64 flows only).
- Allowed MIME types: png, jpeg, webp, gif, mp4, webm, mov, mp3, wav, m4a (and matching audio MIME variants used by the allowlist).

### R2 CORS (required for direct browser PUT)

Without CORS, the browser `PUT` to the presigned URL fails even when credentials are correct.

On the production bucket (e.g. `higgsfield1`), set CORS rules:

| Setting | Value |
|---------|--------|
| Allowed origins | Production origin (e.g. `https://higgsfield-n7pq.vercel.app`) and `http://localhost:3000` for local cloud-mode testing |
| Allowed methods | `PUT`, `GET`, `HEAD` |
| Allowed headers | `Content-Type` |
| Max age | `3600` |

Cloudflare dashboard: R2 → bucket → Settings → CORS policy. Paste the ready file [`scripts/r2-cors.json`](../scripts/r2-cors.json), or:

```json
[
  {
    "AllowedOrigins": [
      "https://higgsfield-n7pq.vercel.app",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Object Read & Write API tokens usually **cannot** change CORS. Prefer the dashboard (account Admin), or create an Admin R2 token and run:

```bash
node --env-file=.env scripts/apply-r2-cors.mjs
```

Symptom in the browser without this policy: CORS error on `*.r2.cloudflarestorage.com` after a successful `/api/upload-presign`.

### Verify uploads after deploy

1. Sign in on Production (guest mode off).
2. Upload an image or audio **larger than 4 MB** from Gallery or a canvas input node.
3. In DevTools → Network: expect a small `POST /api/upload-presign`, then a `PUT` to `*.r2.cloudflarestorage.com` (or the signed host), then `POST /api/upload-complete` — **not** a multi-MB `POST /api/upload-asset`.
4. Open the returned CDN URL (`R2_PUBLIC_URL/...`) in a new tab; it should load.
5. Local smoke (optional): with guest off and R2 env set, `node scripts/smoke-direct-upload.mjs` exercises presign → PUT → HEAD on the CDN URL.

## 6. Troubleshooting

| Symptom | Likely cause | What to check |
|---------|--------------|---------------|
| Jobs stay **pending** forever | Callback hit another instance / mirror failed / wrong `CALLBACK_BASE_URL` | Confirm callback URL is public HTTPS; job-status/stream recover from `generations`; R2 env complete |
| **401** on generate / upload | Missing session or missing per-user kie key | Sign in; Settings → save kie.ai key; Bearer or cookie session present |
| **429** from generate | kie.ai rate limit | Wait and retry; message: rate limiting — wait a few seconds |
| Empty / insufficient **balance** | kie.ai account out of credits | Message: not enough credits — account owner adds credits |
| Large upload fails with **413** on Production | Hitting proxy `/api/upload-asset` or CORS blocking PUT | Network should show PUT to R2; set bucket CORS; client uses `uploadAssetFile` |
| Direct PUT fails (CORS / opaque error) | Missing R2 CORS for the site origin | Add Production + localhost origins; methods PUT/GET/HEAD; header Content-Type |
| Invite / reset link problems | Wrong email template or Site URL | Templates must use `/api/auth/callback?token_hash=…&type=invite\|recovery`; Site URL matches deployment; `AuthEvents` mounted |

## Notes for operators

- Callback hardening: only updates rows that exist and are not already terminal; result URLs must be `https` on the download allowlist.
- `fetch-url` uses `lib/safeFetch.ts` (https-only, private IP rejection, redirect checks, timeout, size cap).
- `download` keeps its origin allowlist and does not open arbitrary hosts.
