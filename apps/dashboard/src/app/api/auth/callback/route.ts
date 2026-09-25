import { LogEvents } from "@midday/events/events";
import { setupAnalytics } from "@midday/events/server";
import { getSession } from "@midday/supabase/cached-queries";
import { createClient } from "@midday/supabase/server";
import { sanitizeRedirectPath } from "@midday/utils/sanitize-redirect";
import { addSeconds, addYears } from "date-fns";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getTRPCClient } from "@/trpc/server";
import { Cookies } from "@/utils/constants";
import { getUrl } from "@/utils/environment";
import { isBlockedNewUser } from "@/utils/new-user-gate";
import { normalizeRedirectPath } from "@/utils/redirect-path";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const requestUrl = new URL(req.url);
  const origin = getUrl();
  const code = requestUrl.searchParams.get("code");
  const client = requestUrl.searchParams.get("client");
  const returnTo = requestUrl.searchParams.get("return_to");
  const provider = requestUrl.searchParams.get("provider");
  const callbackError = requestUrl.searchParams.get("error");

  if (callbackError) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  if (client === "desktop") {
    return NextResponse.redirect(`${origin}/verify?code=${code}`);
  }

  if (provider) {
    cookieStore.set(Cookies.PreferredSignInProvider, provider, {
      expires: addYears(new Date(), 1),
    });
  }

  if (code) {
    const supabase = await createClient();
    const { error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);

    if (exchangeError) {
      return NextResponse.redirect(`${origin}/login?error=oauth`);
    }

    const {
      data: { session },
    } = await getSession();

    if (!session) {
      return NextResponse.redirect(`${origin}/login?error=oauth`);
    }

    if (isBlockedNewUser(session.user.created_at)) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?waitlist=1`);
    }

    // Set cookie to force primary database reads for subsequent client-side
    // requests after redirect. This prevents replication lag issues when the
    // user record hasn't replicated to read replicas yet.
    cookieStore.set(Cookies.ForcePrimary, "true", {
      expires: addSeconds(new Date(), 30),
      httpOnly: false, // Needs to be readable by client-side tRPC
      sameSite: "lax",
    });

    // If user is redirected from an invite, redirect to teams page to accept/decline the invite
    if (returnTo?.startsWith("teams/invite/")) {
      const analytics = await setupAnalytics();
      analytics.track({
        event: LogEvents.SignIn.name,
        channel: LogEvents.SignIn.channel,
        provider: provider ?? "unknown",
        destination: "teams",
      });

      return NextResponse.redirect(`${origin}/teams`);
    }

    // Explicitly force primary reads for this query -- the user may have
    // just been created and not yet replicated to read replicas.
    const trpcClient = await getTRPCClient({ forcePrimary: true });

    let user: Awaited<
      ReturnType<typeof trpcClient.user.me.query>
    > | null = null;
    try {
      user = await trpcClient.user.me.query();
    } catch {
      user = null;
    }

    // Pending invites take priority over creating a company, even if the user
    // has not set a full name yet (typical for brand-new invitees).
    if (!user?.teamId) {
      try {
        const invites = await trpcClient.team.invitesByEmail.query();
        if (invites.length > 0) {
          return NextResponse.redirect(`${origin}/teams`);
        }
      } catch {
        // Fall through if invite lookup fails.
      }
    }

    const isOnboarding = !user?.fullName || !user?.teamId;
    const analytics = await setupAnalytics();

    analytics.track({
      event: LogEvents.SignIn.name,
      channel: LogEvents.SignIn.channel,
      provider: provider ?? "unknown",
      destination: isOnboarding ? "onboarding" : "dashboard",
    });

    if (isOnboarding) {
      return NextResponse.redirect(`${origin}/onboarding`);
    }
  }

  if (returnTo) {
    const normalized = normalizeRedirectPath(returnTo);
    const safePath = sanitizeRedirectPath(normalized);
    return NextResponse.redirect(new URL(safePath, origin));
  }

  return NextResponse.redirect(origin);
}
