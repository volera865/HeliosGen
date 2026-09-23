#!/usr/bin/env node
/**
 * Verifies invite landing hosts for HeliosGen Cloud.
 *
 *   node scripts/verify-invite-landing.mjs
 *
 * Expects Production to be public and Preview (git-main) may be SSO-protected.
 * Does not print secrets.
 */

const PRODUCTION = process.env.VERIFY_PRODUCTION_URL ?? "https://higgsfield-n7pq.vercel.app";
const PREVIEW =
  process.env.VERIFY_PREVIEW_URL ?? "https://higgsfield-n7pq-git-main-volera1.vercel.app";

async function head(url) {
  const res = await fetch(url, { method: "GET", redirect: "manual" });
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
  };
}

function isVercelSso(location) {
  return /vercel\.com\/sso/i.test(location) || /_vercel_sso/i.test(location);
}

async function main() {
  console.log("HeliosGen invite landing check\n");
  console.log(`Production: ${PRODUCTION}`);
  console.log(`Preview:    ${PREVIEW}\n`);

  const prod = await head(PRODUCTION + "/");
  const prev = await head(PREVIEW + "/");
  const cb = await head(PRODUCTION + "/api/auth/callback");

  const prodOk = prod.status >= 200 && prod.status < 400 && !isVercelSso(prod.location);
  const prevProtected = isVercelSso(prev.location) || prev.status === 401 || prev.status === 403;
  const cbReachable = cb.status >= 200 && cb.status < 400;

  console.log(
    prodOk
      ? `[PASS] Production is publicly reachable (HTTP ${prod.status}${prod.location ? " → " + prod.location : ""})`
      : `[FAIL] Production blocked or unexpected (HTTP ${prod.status} loc=${prod.location})`,
  );
  console.log(
    prevProtected
      ? `[PASS] Preview is SSO/protected (invitees must NOT use this as Site URL) — HTTP ${prev.status}`
      : `[WARN] Preview does not look SSO-protected (HTTP ${prev.status} loc=${prev.location})`,
  );
  console.log(
    cbReachable
      ? `[PASS] Production /api/auth/callback reachable (HTTP ${cb.status})`
      : `[FAIL] Production /api/auth/callback unexpected (HTTP ${cb.status})`,
  );

  console.log(`
Dashboard must use:
  Site URL:     ${PRODUCTION}
  Redirect URL: ${PRODUCTION}/api/auth/callback
  Invite link:  {{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=invite
  Vercel env:   CALLBACK_BASE_URL=${PRODUCTION}
`);

  if (!prodOk || !cbReachable) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
