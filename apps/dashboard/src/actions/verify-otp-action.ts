"use server";

import { createClient } from "@midday/supabase/server";
import { sanitizeRedirectPath } from "@midday/utils/sanitize-redirect";
import { addSeconds, addYears } from "date-fns";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getTRPCClient } from "@/trpc/server";
import { Cookies } from "@/utils/constants";
import { getUrl } from "@/utils/environment";
import { isBlockedNewUser } from "@/utils/new-user-gate";
import { normalizeRedirectPath } from "@/utils/redirect-path";
import { actionClient } from "./safe-action";

export const verifyOtpAction = actionClient
  .schema(
    z.object({
      token: z.string(),
      email: z.string(),
      redirectTo: z.string(),
    }),
  )
  .action(async ({ parsedInput: { email, token, redirectTo } }) => {
    const supabase = await createClient();

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });

    if (verifyError) {
      throw new Error("Failed to verify one-time password", {
        cause: verifyError,
      });
    }

    // Validate that the session was actually established (similar to OAuth callback)
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError || !session) {
      throw new Error("Failed to establish session after OTP verification", {
        cause: sessionError,
      });
    }

    if (isBlockedNewUser(session.user.created_at)) {
      await supabase.auth.signOut();
      redirect(`${getUrl()}/login?waitlist=1`);
    }

    const cookieStore = await cookies();

    cookieStore.set(Cookies.PreferredSignInProvider, "otp", {
      expires: addYears(new Date(), 1),
    });

    // Force primary database reads for subsequent requests after redirect.
    // This prevents replication lag issues when the user record hasn't
    // replicated to read replicas yet (same as the OAuth callback).
    cookieStore.set(Cookies.ForcePrimary, "true", {
      expires: addSeconds(new Date(), 30),
      httpOnly: false, // Needs to be readable by client-side tRPC
      sameSite: "lax",
    });

    const trpcClient = await getTRPCClient({ forcePrimary: true });

    // Brand-new OTP users may still be materializing in the users table.
    let user: Awaited<ReturnType<typeof trpcClient.user.me.query>> | undefined;
    try {
      user = await trpcClient.user.me.query();
    } catch {
      user = undefined;
    }

    // Pending invites always come first for users without a team — including
    // brand-new accounts that only exist after this OTP verification.
    // Invite lookup uses JWT/top-level email (or users.email fallback), so the
    // email used for this OTP must match the invited address.
    if (!user?.teamId) {
      try {
        const invites = await trpcClient.team.invitesByEmail.query();
        if (invites.length > 0) {
          redirect(`${getUrl()}/teams`);
        }
      } catch {
        // Invite lookup failed; fall through to onboarding / redirectTo.
      }
    }

    // Also honor explicit return_to=/teams (e.g. invite email → login).
    const normalizedRedirectPath = normalizeRedirectPath(redirectTo);
    const safeRedirectPath = sanitizeRedirectPath(normalizedRedirectPath);
    if (
      !user?.teamId &&
      (safeRedirectPath === "/teams" || safeRedirectPath.startsWith("/teams/"))
    ) {
      redirect(new URL(safeRedirectPath, getUrl()).toString());
    }

    if (!user?.fullName || !user?.teamId) {
      redirect(`${getUrl()}/onboarding`);
    }

    redirect(new URL(safeRedirectPath, getUrl()).toString());
  });
