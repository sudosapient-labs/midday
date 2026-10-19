import { useEffect, useState } from "react";
import { useJobStatus } from "@/hooks/use-job-status";

type UseSyncStatusProps = {
  /** Composite BullMQ job ID returned by the API (e.g., "bank:42") */
  runId?: string;
};

export type SyncStatus = "FAILED" | "SYNCING" | "COMPLETED" | null;

/**
 * Track a background sync job by polling its BullMQ status
 */
export function useSyncStatus({ runId }: UseSyncStatusProps) {
  const [status, setStatus] = useState<SyncStatus>(null);

  const {
    status: jobStatus,
    result,
    queryError,
  } = useJobStatus({
    jobId: runId,
    enabled: !!runId,
  });

  useEffect(() => {
    if (runId) {
      setStatus("SYNCING");
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      return;
    }

    if (queryError || jobStatus === "failed") {
      setStatus("FAILED");
    }

    if (jobStatus === "completed") {
      setStatus("COMPLETED");
    }
  }, [runId, jobStatus, queryError]);

  return {
    status,
    setStatus,
    result: result as Record<string, unknown> | undefined,
  };
}
