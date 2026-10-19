import { createLoggerWithContext } from "@midday/logger";
import type { QueueOptions, WorkerOptions } from "bullmq";
import { getRedisConnection } from "../config";
import type { QueueConfig } from "../types/queue-config";

const logger = createLoggerWithContext("worker:queue:bank");

/**
 * Queue options for bank queue
 */
const bankQueueOptions: QueueOptions = {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
};

/**
 * Worker options for bank queue
 * Moderate concurrency - every job calls external banking providers
 * Lock duration: 10 minutes - a connection sync walks every account sequentially
 */
const bankWorkerOptions: WorkerOptions = {
  connection: getRedisConnection(),
  concurrency: 10,
  lockDuration: 600000, // 10 minutes
  stalledInterval: 660000, // 11 minutes - longer than lockDuration
  maxStalledCount: 1,
};

/**
 * Bank queue configuration
 * Jobs: initial-bank-setup, sync-connection, reconnect-connection,
 * delete-connection, bank-sync-scheduler, ensure-bank-schedulers,
 * transaction-notifications
 */
export const bankQueueConfig: QueueConfig = {
  name: "bank",
  queueOptions: bankQueueOptions,
  workerOptions: bankWorkerOptions,
  eventHandlers: {
    onCompleted: (job) => {
      logger.info("Job completed", { jobName: job.name, jobId: job.id });
    },
    onFailed: (job, err) => {
      logger.error("Job failed", {
        jobName: job?.name,
        jobId: job?.id,
        error: err.message,
      });
    },
  },
};
