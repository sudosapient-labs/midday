import { z } from "zod";

/**
 * Team job schemas
 */

const bankConnectionSchema = z.object({
  referenceId: z.string().nullable(),
  provider: z.string(),
  accessToken: z.string().nullable(),
});

export const deleteTeamSchema = z.object({
  teamId: z.string().uuid(),
  connections: z.array(bankConnectionSchema),
});

export type DeleteTeamPayload = z.infer<typeof deleteTeamSchema>;

export const cancellationEmailsSchema = z.object({
  teamId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
});

export type CancellationEmailsPayload = z.infer<
  typeof cancellationEmailsSchema
>;

export const paymentIssueSchema = z.object({
  teamId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
  teamName: z.string(),
});

export type PaymentIssuePayload = z.infer<typeof paymentIssueSchema>;

export const inviteTeamMembersSchema = z.object({
  teamId: z.string().uuid(),
  ip: z.string(),
  locale: z.string(),
  invites: z.array(
    z.object({
      email: z.string().email(),
      invitedByName: z.string(),
      invitedByEmail: z.string().email(),
      teamName: z.string(),
    }),
  ),
});

export type InviteTeamMembersPayload = z.infer<typeof inviteTeamMembersSchema>;

export const onboardTeamSchema = z.object({
  userId: z.string().uuid(),
});

export type OnboardTeamPayload = z.infer<typeof onboardTeamSchema>;
