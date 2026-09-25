import {
  acceptTeamInviteSchema,
  createTeamSchema,
  declineTeamInviteSchema,
  deleteTeamInviteSchema,
  deleteTeamMemberSchema,
  deleteTeamSchema,
  inviteTeamMembersSchema,
  leaveTeamSchema,
  updateBaseCurrencySchema,
  updateTeamByIdSchema,
  updateTeamMemberSchema,
} from "@api/schemas/team";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import { sendTeamInviteEmails } from "@api/utils/team-invite-email";
import type { InviteTeamMembersPayload } from "@jobs/schema";

import { teamCache } from "@midday/cache/team-cache";
import {
  acceptTeamInvite,
  createTeam,
  createTeamInvites,
  declineTeamInvite,
  deleteTeam,
  deleteTeamInvite,
  deleteTeamMember,
  getAvailablePlans,
  getBankConnections,
  getInboxAccounts,
  getInvitesByEmail,
  getTeamById,
  getTeamInvites,
  getTeamMemberRole,
  getTeamMembersByTeamId,
  getTeamsByUserId,
  getUserById,
  hasTeamAccess,
  leaveTeam,
  updateTeamById,
  updateTeamMember,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { logger } from "@midday/logger";
import { tasks } from "@trigger.dev/sdk";
import { TRPCError } from "@trpc/server";

export const teamRouter = createTRPCRouter({
  current: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    if (!teamId) {
      return null;
    }

    return getTeamById(db, teamId!);
  }),

  update: protectedProcedure
    .input(updateTeamByIdSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return updateTeamById(db, {
        id: teamId!,
        data: input,
      });
    }),

  members: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getTeamMembersByTeamId(db, teamId!);
  }),

  list: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    return getTeamsByUserId(db, session.user.id);
  }),

  create: protectedProcedure
    .input(createTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      const teamId = await createTeam(db, {
        ...input,
        userId: session.user.id,
        email: session.user.email!,
        companyType: input.companyType,
      });

      if (input.switchTeam) {
        try {
          await teamCache.invalidateForUser(session.user.id);
        } catch {
          // Non-fatal — cache will expire naturally
        }
      }

      return teamId;
    }),

  leave: protectedProcedure
    .input(leaveTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      const teamMembersData = await getTeamMembersByTeamId(db, input.teamId);

      const currentUser = teamMembersData?.find(
        (member) => member.user?.id === session.user.id,
      );

      const totalOwners = teamMembersData?.filter(
        (member) => member.role === "owner",
      ).length;

      if (currentUser?.role === "owner" && totalOwners === 1) {
        throw Error("Action not allowed");
      }

      const result = await leaveTeam(db, {
        userId: session.user.id,
        teamId: input.teamId,
      });

      try {
        await teamCache.invalidateForUser(session.user.id, input.teamId);
      } catch {
        // Non-fatal — cache will expire naturally
      }

      return result;
    }),

  acceptInvite: protectedProcedure
    .input(acceptTeamInviteSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      let email = session.user.email;
      if (!email) {
        const user = await getUserById(db, session.user.id);
        email = user?.email ?? undefined;
      }

      if (!email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email is required to accept an invite",
        });
      }

      return acceptTeamInvite(db, {
        id: input.id,
        userId: session.user.id,
        userEmail: email,
      });
    }),

  declineInvite: protectedProcedure
    .input(declineTeamInviteSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      let email = session.user.email;
      if (!email) {
        const user = await getUserById(db, session.user.id);
        email = user?.email ?? undefined;
      }

      if (!email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email is required to decline an invite",
        });
      }

      return declineTeamInvite(db, {
        id: input.id,
        email,
      });
    }),

  delete: protectedProcedure
    .input(deleteTeamSchema)
    .mutation(async ({ ctx: { db, session }, input }) => {
      // Check if the user has access to the team before deleting
      const canAccess = await hasTeamAccess(db, input.teamId, session.user.id);

      if (!canAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have access to this team",
        });
      }

      // Fetch team data BEFORE deleting (for cleanup job)
      const team = await getTeamById(db, input.teamId);

      if (!team) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Team not found",
        });
      }

      const bankConnections = await getBankConnections(db, {
        teamId: input.teamId,
      });

      // Trigger cleanup job BEFORE deleting team from database.
      // This ensures that if job triggering fails (Redis down, queue unavailable),
      // the team remains intact and the user can retry. The cleanup job will handle
      // bank connection deletion. Subscription cancellation should be done manually
      // by the user via the customer portal before deleting the team.
      await triggerJob(
        "delete-team",
        {
          teamId: input.teamId!,
          connections: bankConnections.map((c) => ({
            referenceId: c.referenceId,
            provider: c.provider,
            accessToken: c.accessToken,
          })),
        },
        "teams",
      );

      const data = await deleteTeam(db, {
        teamId: input.teamId,
        userId: session.user.id,
      });

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete team",
        });
      }

      try {
        await Promise.all([
          ...data.memberUserIds.map((userId) =>
            Promise.all([teamCache.invalidateForUser(userId, input.teamId)]),
          ),
        ]);
      } catch {
        // Non-fatal — team deletion succeeded, cache will expire naturally
      }
    }),

  deleteMember: protectedProcedure
    .input(deleteTeamMemberSchema)
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      if (input.teamId !== teamId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have access to this team",
        });
      }

      const callerRole = await getTeamMemberRole(db, teamId!, session.user.id);

      if (callerRole !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only team owners can remove members",
        });
      }

      // Prevent removing the last owner
      const targetRole = await getTeamMemberRole(db, teamId!, input.userId);

      if (targetRole === "owner") {
        const teamMembers = await getTeamMembersByTeamId(db, teamId!);
        const totalOwners = teamMembers?.filter(
          (member) => member.role === "owner",
        ).length;

        if (totalOwners === 1) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot remove the last team owner",
          });
        }
      }

      const result = await deleteTeamMember(db, {
        teamId: input.teamId,
        userId: input.userId,
      });

      try {
        await teamCache.invalidateForUser(input.userId, input.teamId);
      } catch {
        // Non-fatal — cache will expire naturally
      }

      return result;
    }),

  updateMember: protectedProcedure
    .input(updateTeamMemberSchema)
    .mutation(async ({ ctx: { db, session, teamId }, input }) => {
      if (input.teamId !== teamId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have access to this team",
        });
      }

      const callerRole = await getTeamMemberRole(db, teamId!, session.user.id);

      if (callerRole !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only team owners can update member roles",
        });
      }

      // Prevent demoting the last owner to member
      if (input.role === "member") {
        const targetRole = await getTeamMemberRole(db, teamId!, input.userId);

        if (targetRole === "owner") {
          const teamMembers = await getTeamMembersByTeamId(db, teamId!);
          const totalOwners = teamMembers?.filter(
            (member) => member.role === "owner",
          ).length;

          if (totalOwners === 1) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Cannot demote the last team owner",
            });
          }
        }
      }

      return updateTeamMember(db, input);
    }),

  teamInvites: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getTeamInvites(db, teamId!);
  }),

  invitesByEmail: protectedProcedure.query(async ({ ctx: { db, session } }) => {
    // Email/OTP JWTs may omit email in metadata; fall back to the users row.
    let email = session.user.email;
    if (!email) {
      const user = await getUserById(db, session.user.id);
      email = user?.email ?? undefined;
    }

    if (!email) {
      return [];
    }

    return getInvitesByEmail(db, email);
  }),

  invite: protectedProcedure
    .input(inviteTeamMembersSchema)
    .mutation(async ({ ctx: { db, session, teamId, geo }, input }) => {
      const invitedByEmail = session.user.email;
      if (!invitedByEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email is required to invite team members",
        });
      }

      const ip = geo.ip ?? "127.0.0.1";

      const data = await createTeamInvites(db, {
        teamId: teamId!,
        invites: input.map((invite) => ({
          ...invite,
          invitedBy: session.user.id,
        })),
      });

      const results = data?.results ?? [];
      const skippedInvites = data?.skippedInvites ?? [];

      const [team, inviter] = await Promise.all([
        getTeamById(db, teamId!),
        getUserById(db, session.user.id),
      ]);
      const invitedByName =
        inviter?.fullName ?? session.user.full_name ?? invitedByEmail;
      const emailableAddresses = new Set(
        [
          ...results.flatMap((invite) => (invite?.email ? [invite.email] : [])),
          ...skippedInvites.flatMap((invite) =>
            invite.reason === "already_invited" ? [invite.email] : [],
          ),
        ].map((email) => email.toLowerCase()),
      );

      // Re-send existing pending invitations as well as newly created ones.
      // This makes delivery failures recoverable on the next invite attempt.
      const uniqueInput = input.filter(
        (invite, index, all) =>
          index ===
          all.findIndex(
            (candidate) =>
              candidate.email.toLowerCase() === invite.email.toLowerCase(),
          ),
      );
      const invites: InviteTeamMembersPayload["invites"] = uniqueInput
        .filter((invite) =>
          emailableAddresses.has(invite.email.toLowerCase()),
        )
        .map((invite) => ({
          email: invite.email,
          invitedByName,
          invitedByEmail,
          teamName: team?.name ?? "",
        }));

      if (invites.length > 0) {
        const payload = {
          teamId: teamId!,
          invites,
          ip,
          locale: "en",
        } satisfies InviteTeamMembersPayload;
        const triggerKey = process.env.TRIGGER_SECRET_KEY?.trim();
        const canUseTrigger =
          process.env.NODE_ENV !== "production" ||
          Boolean(triggerKey && triggerKey !== "local-disabled");

        if (canUseTrigger) {
          try {
            await tasks.trigger("invite-team-members", payload);
          } catch (error) {
            logger.warn(
              "[team.invite] Trigger.dev unavailable; sending directly",
              {
                error:
                  error instanceof Error ? error.message : String(error),
              },
            );
            await sendTeamInviteEmails(payload);
          }
        } else {
          await sendTeamInviteEmails(payload);
        }
      }

      const actuallySkipped = skippedInvites.filter(
        (invite) => invite.reason !== "already_invited",
      );

      // Return information about the invitation process
      return {
        sent: invites.length,
        skipped: actuallySkipped.length,
        skippedInvites: actuallySkipped,
      };
    }),

  deleteInvite: protectedProcedure
    .input(deleteTeamInviteSchema)
    .mutation(async ({ ctx: { db, teamId }, input }) => {
      return deleteTeamInvite(db, {
        teamId: teamId!,
        id: input.id,
      });
    }),

  availablePlans: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getAvailablePlans(db, teamId!);
  }),

  updateBaseCurrency: protectedProcedure
    .input(updateBaseCurrencySchema)
    .mutation(async ({ ctx: { teamId }, input }) => {
      return triggerJob(
        "update-base-currency",
        {
          teamId: teamId!,
          baseCurrency: input.baseCurrency,
        },
        "transactions",
      );
    }),

  exportAllData: protectedProcedure.mutation(
    async ({ ctx: { teamId, session } }) => {
      if (!teamId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Team not found",
        });
      }

      return triggerJob(
        "export-team-data",
        {
          teamId,
          userId: session.user.id,
          userEmail: session.user.email ?? undefined,
        },
        "transactions",
      );
    },
  ),

  /**
   * Get unified connection status for the team.
   * Returns raw connection data - presentation logic handled by client.
   */
  connectionStatus: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      if (!teamId) {
        return { bankConnections: [], inboxAccounts: [] };
      }

      // Fetch bank connections and inbox accounts in parallel
      const [bankConnections, inboxAccounts] = await Promise.all([
        getBankConnections(db, { teamId }),
        getInboxAccounts(db, teamId),
      ]);

      return {
        bankConnections: bankConnections.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          expiresAt: c.expiresAt,
          logoUrl: c.logoUrl,
        })),
        inboxAccounts: inboxAccounts.map((a) => ({
          id: a.id,
          email: a.email,
          status: a.status,
          provider: a.provider,
        })),
      };
    },
  ),
});
