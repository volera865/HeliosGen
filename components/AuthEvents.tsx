"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useWorkflowStore } from "@/lib/store";

/**
 * Headless listener for Supabase auth redirects.
 *
 * The same logic lives in components/AuthButton.tsx, but that component is
 * never rendered, so invite and password-recovery links never opened the
 * "set password" screen. This mounts once (from GlobalModals) and only wires
 * up the listeners — ResetPasswordModal itself is mounted there too.
 */
export default function AuthEvents() {
  const setAuthModalOpen          = useWorkflowStore((s) => s.setAuthModalOpen);
  const setAuthModalView          = useWorkflowStore((s) => s.setAuthModalView);
  const setResetPasswordModalOpen = useWorkflowStore((s) => s.setResetPasswordModalOpen);
  const addToast                  = useWorkflowStore((s) => s.addToast);
  const supabase                  = createClient();

  useEffect(() => {
    // Handle Supabase auth hash params on page load.
    const hash   = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);

    if (params.get("type") === "recovery") {
      // Valid recovery link — establish session then open the reset modal.
      const access_token  = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      if (access_token && refresh_token) {
        supabase.auth.setSession({ access_token, refresh_token }).then(() => {
          setResetPasswordModalOpen(true);
        });
      } else {
        setResetPasswordModalOpen(true);
      }
    } else if (params.get("error")) {
      // Supabase returned an auth error (e.g. expired OTP).
      // Open the forgot-password flow so they can request a new link.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      addToast("Reset link expired — please request a new one.", "info");
      setAuthModalView("forgot");
      setAuthModalOpen(true);
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setResetPasswordModalOpen(true);
      }
    });
    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
