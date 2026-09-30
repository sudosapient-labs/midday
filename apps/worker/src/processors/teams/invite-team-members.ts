import { InviteEmail } from "@midday/email/emails/invite";
import { getI18n } from "@midday/email/locales";
import { render } from "@midday/email/render";
import type { Job } from "bullmq";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import type { InviteTeamMembersPayload } from "../../schemas/teams";
import { BaseProcessor } from "../base";

const resend = new Resend(process.env.RESEND_API_KEY!);

/**
 * Send invite emails to new team members
 */
export class InviteTeamMembersProcessor extends BaseProcessor<InviteTeamMembersPayload> {
  async process(job: Job<InviteTeamMembersPayload>) {
    const { ip, invites, locale } = job.data;
    const { t } = getI18n({ locale });

    const emails = await Promise.all(
      invites.map(async (invite) => ({
        from: "Midday <midday@sudosapient.dev>",
        to: [invite.email],
        subject: t("invite.subject", {
          invitedByName: invite.invitedByName,
          teamName: invite.teamName,
        }),
        headers: {
          "X-Entity-Ref-ID": nanoid(),
        },
        html: await render(
          InviteEmail({
            invitedByEmail: invite.invitedByEmail,
            invitedByName: invite.invitedByName,
            email: invite.email,
            teamName: invite.teamName,
            ip,
            locale,
          }),
        ),
      })),
    );

    await resend.batch.send(emails);

    return { sent: emails.length };
  }
}
