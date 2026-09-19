import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// Invite and recovery links have to land on the "set password" screen. The
// client listener (components/AuthEvents.tsx) opens that modal when it sees
// this hash, which is the same shape Supabase's implicit links already use.
const SET_PASSWORD_HASH = "#type=recovery";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code      = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type      = searchParams.get("type");
  const next      = searchParams.get("next") ?? "/";

  // Both flows mean "you do not have a password yet / you are replacing it".
  const needsPassword = type === "recovery" || type === "invite";
  const destination = `${origin}${next}${needsPassword ? SET_PASSWORD_HASH : ""}`;

  if (code || tokenHash) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(destination);
      }
    } else if (tokenHash && type) {
      // Email templates built with {{ .TokenHash }} arrive here instead of
      // carrying a PKCE `code`.
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (!error) {
        return NextResponse.redirect(destination);
      }
    }
  }

  return NextResponse.redirect(`${origin}/?auth_error=1`);
}
