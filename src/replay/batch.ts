/**
 * Bulk replay: one skill over many parameter rows.
 *
 * The loop's whole job beyond iterating is knowing when to STOP. Rows fail for
 * two very different reasons, and treating them alike is what turns a bad
 * afternoon into a bad week:
 *
 *  - **Row-local**: this SKU doesn't exist, this value is rejected. The next
 *    row is unaffected, so continuing is right -- that is why bulk mode
 *    continues on failure at all.
 *  - **Systemic**: the session expired, the site was redesigned, the app is
 *    down. Every remaining row will fail the same way. Grinding through 86 more
 *    of them helps nobody: it burns a heal budget per row against a login wall,
 *    and buries the one line that matters (row 214 died, and why) under 86
 *    identical ones.
 *
 * Nothing can tell the two apart from a single failure. A RUN of them is the
 * signal: consecutive failures mean the fault is no longer about the row. So
 * the breaker trips after `maxConsecutiveFailures` in a row, and any success
 * resets the count -- an unlucky scatter of bad SKUs never trips it, a dead
 * session trips it immediately.
 *
 * This is the mid-batch counterpart to the warm-up prefix: warm-up catches
 * systemic breakage before the first write, the breaker catches it the moment
 * it starts, and between them a batch never fails 300 times to learn one thing.
 */

export interface BatchRowResult {
  status: "success" | "failure" | "blocked";
  summary: string;
}

export interface BatchOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  /** Rows never tried because the breaker tripped. */
  abandoned: number;
  /** The consecutive-failure run that tripped the breaker, if it tripped. */
  trippedAfter?: number;
}

export interface BatchOptions<T> {
  rows: T[];
  runOne: (row: T, index: number) => Promise<BatchRowResult>;
  /** Consecutive failures that mean "this is not about the row" (default 3). */
  maxConsecutiveFailures?: number;
  /** Called before each row, for progress output. */
  onRowStart?: (row: T, index: number, total: number) => void;
  /** Called with each row's result, for progress output. */
  onRowEnd?: (result: BatchRowResult, index: number, total: number) => void;
  /** Called once when the breaker trips, before returning. */
  onTrip?: (outcome: BatchOutcome) => void;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export async function runBatch<T>(opts: BatchOptions<T>): Promise<BatchOutcome> {
  const limit = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const total = opts.rows.length;
  const outcome: BatchOutcome = { attempted: 0, succeeded: 0, failed: 0, abandoned: 0 };
  let consecutive = 0;

  for (const [i, row] of opts.rows.entries()) {
    opts.onRowStart?.(row, i, total);
    const result = await opts.runOne(row, i);
    outcome.attempted++;
    if (result.status === "success") {
      outcome.succeeded++;
      consecutive = 0; // the fault was about the row, not the world
    } else {
      outcome.failed++;
      consecutive++;
    }
    opts.onRowEnd?.(result, i, total);

    // A single-row "batch" has nothing to protect: let it report its own
    // failure rather than dressing it up as a tripped breaker.
    if (total > 1 && consecutive >= limit) {
      outcome.trippedAfter = consecutive;
      outcome.abandoned = total - outcome.attempted;
      opts.onTrip?.(outcome);
      return outcome;
    }
  }
  return outcome;
}
