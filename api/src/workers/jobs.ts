import {
  autoCloseResolved,
  ensurePartitions,
  purgeIdempotencyKeys,
  reconcileLoad,
} from "../services/maintenanceService.js";
import { retryRouting } from "../services/routingService.js";

// The list of scheduled jobs: a name, how often it runs, and the function.
//
// A job is only a thin wrapper. The work is in the service layer, so a job
// obeys the same rules as a person's request (state machine, timeline,
// outbox) and can be tested by calling the service function directly.
//
// Every job must be IDEMPOTENT: it may run twice (a crash, a retry, two
// workers), and running it twice must leave the same result as once.

export type JobDefinition = {
  everyMs: number;
  run: () => Promise<object>; // the returned summary is stored as the job's result
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const JOBS: Record<string, JobDefinition> = {
  "routing-retry": { everyMs: 2 * MINUTE, run: () => retryRouting() },
  "auto-close": { everyMs: HOUR, run: () => autoCloseResolved() },
  "partition-maintenance": { everyMs: DAY, run: () => ensurePartitions() },
  "load-reconciliation": { everyMs: DAY, run: () => reconcileLoad() },
  "idempotency-cleanup": { everyMs: DAY, run: () => purgeIdempotencyKeys() },
};
