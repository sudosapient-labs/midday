import { TrialActivationEmail } from "@midday/email/emails/trial-activation";
import { WelcomeEmail } from "@midday/email/emails/welcome";
import { render } from "@midday/email/render";
import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { Resend } from "resend";
import type { OnboardTeamPayload } from "../../schemas/teams";
import { BaseProcessor } from "../base";

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM = "Pontus from Midday <midday@sudosapient.dev>";

// Day 3: activation nudge to encourage a bank connection
const ACTIVATION_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

async function getUser(userId: string) {
  const supabase = createClient();

  const { data: user, error } = await supabase
    .from("users")
    .select("id, full_name, email, team_id")
    .eq("id", userId)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  if (!user.full_name || !user.email) {
    throw new Error("User data is missing");
  }

  return { ...user, full_name: user.full_name, email: user.email };
}

/**
 * Welcome a newly registered user and schedule the activation nudge
 */
export class OnboardTeamProcessor extends BaseProcessor<OnboardTeamPayload> {
  async process(job: Job<OnboardTeamPayload>) {
    const { userId } = job.data;
    const user = await getUser(userId);

    const [firstName, lastName] = user.full_name.split(" ");

    if (process.env.RESEND_AUDIENCE_ID) {
      await resend.contacts.create({
        email: user.email,
        firstName,
        lastName,
        unsubscribed: false,
        audienceId: process.env.RESEND_AUDIENCE_ID,
      });
    }

    await resend.emails.send({
      to: user.email,
      subject: "Welcome to Midday",
      from: FROM,
      html: await render(WelcomeEmail({ fullName: user.full_name })),
    });

    if (!user.team_id) {
      this.logger.info("User has no team, skipping activation email");
      return { activationScheduled: false };
    }

    await triggerJob("onboard-team-activation", { userId }, "teams", {
      delay: ACTIVATION_DELAY_MS,
      jobId: `onboard-team-activation-${userId}`,
    });

    return { activationScheduled: true };
  }
}

/**
 * Nudge trial teams without a bank connection to connect one
 */
export class OnboardTeamActivationProcessor extends BaseProcessor<OnboardTeamPayload> {
  async process(job: Job<OnboardTeamPayload>) {
    const user = await getUser(job.data.userId);

    if (!user.team_id) {
      return { sent: false };
    }

    const supabase = createClient();

    const { data: team } = await supabase
      .from("teams")
      .select("plan, subscription_status")
      .eq("id", user.team_id)
      .single();

    const isTrial =
      team?.plan === "trial" || team?.subscription_status === "trialing";

    if (!isTrial) {
      return { sent: false };
    }

    const { count } = await supabase
      .from("bank_connections")
      .select("id", { count: "exact", head: true })
      .eq("team_id", user.team_id);

    if (count) {
      return { sent: false };
    }

    await resend.emails.send({
      from: FROM,
      to: user.email,
      subject: "Connect your bank to see the full picture",
      html: await render(TrialActivationEmail({ fullName: user.full_name })),
    });

    return { sent: true };
  }
}
