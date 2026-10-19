import { trpc } from "@midday/trpc";
import type { Job } from "bullmq";
import type { DeleteConnectionPayload } from "../../schemas/bank";
import { BaseProcessor } from "../base";

/**
 * Revoke a bank connection with its provider after it was deleted in Midday
 */
export class DeleteConnectionProcessor extends BaseProcessor<DeleteConnectionPayload> {
  async process(job: Job<DeleteConnectionPayload>): Promise<void> {
    const { referenceId, provider, accessToken } = job.data;

    await trpc.banking.deleteConnection.mutate({
      id: referenceId!,
      provider,
      accessToken: accessToken ?? undefined,
    });
  }
}
