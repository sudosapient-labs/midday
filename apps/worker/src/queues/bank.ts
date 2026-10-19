import { Queue } from "bullmq";
import { bankQueueConfig } from "./bank.config";

/**
 * Bank queue instance
 * Used for enqueueing bank connection setup, sync, and cleanup jobs
 * Configuration is defined in bank.config.ts
 */
export const bankQueue = new Queue("bank", bankQueueConfig.queueOptions);
