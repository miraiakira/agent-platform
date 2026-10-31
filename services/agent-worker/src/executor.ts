import type {
  ClaimedJob,
} from "@eap/persistence";

export interface JobExecutor {
  execute(
    job: ClaimedJob,
    signal: AbortSignal,
  ): Promise<void>;
}