import { useSyncStatus } from "@/hooks/use-sync-status";

type UseInitialConnectionStatusProps = {
  /** Composite BullMQ job ID of the initial-bank-setup job */
  runId?: string;
};

/**
 * Track the initial import after a bank connection is created
 */
export function useInitialConnectionStatus({
  runId,
}: UseInitialConnectionStatusProps) {
  const { status, setStatus } = useSyncStatus({ runId });

  return {
    status,
    setStatus,
  };
}
