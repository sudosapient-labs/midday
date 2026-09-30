import { CancellationEmailFollowupProcessor } from "./cancellation-email-followup";
import { CancellationEmailsProcessor } from "./cancellation-emails";
import { DeleteTeamProcessor } from "./delete-team";
import { InviteTeamMembersProcessor } from "./invite-team-members";
import {
  OnboardTeamActivationProcessor,
  OnboardTeamProcessor,
} from "./onboard-team";
import { PaymentIssueProcessor } from "./payment-issue";

/**
 * Export all team processors (for type imports)
 */
export { CancellationEmailFollowupProcessor } from "./cancellation-email-followup";
export { CancellationEmailsProcessor } from "./cancellation-emails";
export { DeleteTeamProcessor } from "./delete-team";
export { InviteTeamMembersProcessor } from "./invite-team-members";
export {
  OnboardTeamActivationProcessor,
  OnboardTeamProcessor,
} from "./onboard-team";
export { PaymentIssueProcessor } from "./payment-issue";

/**
 * Team processor registry
 * Maps job names to processor instances
 */
export const teamProcessors = {
  "delete-team": new DeleteTeamProcessor(),
  "cancellation-email-immediate": new CancellationEmailsProcessor(),
  "cancellation-email-followup": new CancellationEmailFollowupProcessor(),
  "payment-issue": new PaymentIssueProcessor(),
  "invite-team-members": new InviteTeamMembersProcessor(),
  "onboard-team": new OnboardTeamProcessor(),
  "onboard-team-activation": new OnboardTeamActivationProcessor(),
};
