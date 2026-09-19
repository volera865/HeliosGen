import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.64.2"],
  // `env` is inlined after the NEXT_PUBLIC_* environment values, so this wins:
  // on Vercel the client bundle always sees guest mode as off, matching the
  // server-side guard in lib/guestMode.ts. Local builds are untouched.
  ...(process.env.VERCEL ? { env: { NEXT_PUBLIC_GUEST_MODE: "false" } } : {}),
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    proxyClientMaxBodySize: '30mb',
  },
  serverExternalPackages: ["undici"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.r2.dev" },
      { protocol: "https", hostname: "**.r2.dev" },
      { protocol: "https", hostname: "*.replicate.delivery" },
      { protocol: "https", hostname: "pbxt.replicate.delivery" },
      { protocol: "https", hostname: "*.replicate.com" },
      { protocol: "https", hostname: "*.aiquickdraw.com" },
    ],
  },
};

export default nextConfig;
