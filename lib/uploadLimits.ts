/** Shared MIME allowlist for user media uploads (proxy + presign). */
export const UPLOAD_ALLOWED_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4",
  "audio/m4a", "audio/x-m4a", "audio/aac", "audio/ogg",
]);

/** Max size for direct-to-R2 browser uploads (not limited by Vercel body size). */
export const DIRECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Legacy proxy upload cap (Vercel ~4.5 MB). */
export const PROXY_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
