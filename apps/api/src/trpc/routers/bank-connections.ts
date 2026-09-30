import {
  addProviderAccountsSchema,
  createBankConnectionSchema,
  deleteBankConnectionSchema,
  getBankConnectionsSchema,
  reconnectBankConnectionSchema,
  syncBankConnectionSchema,
  triggerReconnectSchema,
} from "@api/schemas/bank-connections";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";

import {
  addProviderAccounts,
  createBankConnection,
  deleteBankConnection,
  getBankConnections,
  reconnectBankConnection,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { TRPCError } from "@trpc/server";

export const bankConnectionsRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getBankConnectionsSchema)
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getBankConnections(db, {
        teamId: teamId!,
        enabled: input?.enabled,
      });
    }),

  create: protectedProcedure
    .input(createBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const data = await createBankConnection(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      });

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Bank connection not found",
        });
      }

      // The dashboard polls this job (jobs.getStatus) for the initial import
      return triggerJob(
        "initial-bank-setup",
        { connectionId: data.id, teamId: teamId! },
        "bank",
      );
    }),

  delete: protectedProcedure
    .input(deleteBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const data = await deleteBankConnection(db, {
        id: input.id,
        teamId: teamId!,
      });

      if (!data) {
        throw new Error("Bank connection not found");
      }

      await triggerJob(
        "delete-connection",
        {
          referenceId: data.referenceId,
          provider: data.provider!,
          accessToken: data.accessToken,
        },
        "bank",
      );

      return data;
    }),

  addAccounts: protectedProcedure
    .input(addProviderAccountsSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const result = await addProviderAccounts(db, {
        connectionId: input.connectionId,
        teamId: teamId!,
        userId: session.user.id,
        accounts: input.accounts,
      });

      return result;
    }),

  reconnect: protectedProcedure
    .input(reconnectBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const result = await reconnectBankConnection(db, {
        referenceId: input.referenceId,
        newReferenceId: input.newReferenceId,
        expiresAt: input.expiresAt,
        teamId: teamId!,
      });

      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Bank connection not found",
        });
      }

      return result;
    }),

  sync: protectedProcedure
    .input(syncBankConnectionSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      await assertConnectionOwnership(db, teamId!, input.connectionId);

      return triggerJob(
        "sync-connection",
        { connectionId: input.connectionId, teamId: teamId!, manualSync: true },
        "bank",
      );
    }),

  triggerReconnect: protectedProcedure
    .input(triggerReconnectSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      await assertConnectionOwnership(db, teamId!, input.connectionId);

      return triggerJob(
        "reconnect-connection",
        {
          teamId: teamId!,
          connectionId: input.connectionId,
          provider: input.provider,
        },
        "bank",
      );
    }),
});

async function assertConnectionOwnership(
  db: Parameters<typeof getBankConnections>[0],
  teamId: string,
  connectionId: string,
) {
  const connections = await getBankConnections(db, { teamId });

  if (!connections?.some((connection) => connection.id === connectionId)) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Bank connection not found",
    });
  }
}
