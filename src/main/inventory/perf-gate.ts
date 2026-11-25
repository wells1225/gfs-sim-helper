export const HARD_TIME_LIMIT_MS = 30_000
/** A shared CI runner can take well over twice a 1.7 s baseline with nothing wrong, so the limit never goes below this. */
export const MIN_BASELINE_LIMIT_MS = 5_000

export function baselineLimitMs(baselineMs: number): number {
  return Math.max(baselineMs * 2, MIN_BASELINE_LIMIT_MS)
}

export function timingFailures(elapsedMs: number, baselineMs: number | null): string[] {
  const failures: string[] = []
  if (elapsedMs > HARD_TIME_LIMIT_MS) {
    failures.push(`Elapsed time ${elapsedMs} ms exceeded hard limit of ${HARD_TIME_LIMIT_MS} ms`)
  }
  if (baselineMs !== null && elapsedMs > baselineLimitMs(baselineMs)) {
    failures.push(
      `Elapsed time ${elapsedMs} ms exceeded ${baselineLimitMs(baselineMs)} ms ` +
        `(the larger of 2x the ${baselineMs} ms baseline and ${MIN_BASELINE_LIMIT_MS} ms)`
    )
  }
  return failures
}
