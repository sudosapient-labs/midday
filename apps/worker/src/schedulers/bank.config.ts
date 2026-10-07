import type {
  DynamicSchedulerTemplate,
  StaticSchedulerConfig,
} from "../types/scheduler-config";
import { generateCronTag } from "../utils/generate-cron-tag";

/**
 * Static scheduler configurations for bank connections
 */
export const bankStaticSchedulers: StaticSchedulerConfig[] = [
  {
    name: "ensure-bank-schedulers",
    queue: "bank",
    cron: "0 3 * * *", // Daily at 3 AM UTC
    jobName: "ensure-bank-schedulers",
    payload: {},
    options: {
      tz: "UTC",
    },
  },
];

/**
 * Dynamic scheduler templates for bank connections
 * Registered per team when its first bank connection is created
 */
export const bankDynamicSchedulerTemplates: DynamicSchedulerTemplate[] = [
  {
    template: "bank-sync-scheduler",
    queue: "bank",
    // Daily at a deterministic time per team to distribute load
    cronGenerator: (teamId: string) => generateCronTag(teamId),
    jobName: "bank-sync-scheduler",
    payloadGenerator: (teamId: string) => ({ teamId }),
    jobKey: (teamId: string) => `bank-sync-${teamId}`,
    options: {
      tz: "UTC",
    },
  },
];
