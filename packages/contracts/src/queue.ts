/** Queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  AGENT_TASKS: "agent-tasks",
} as const;

export const JOBS = {
  RUN_TASK: "run-task",
} as const;

/**
 * Job payloads carry identifiers only. Credentials, tokens, and repository
 * content are loaded by the worker at execution time and never enqueued.
 */
export interface RunTaskJob {
  taskId: string;
}
