/**
 * CLAUDE.md §7 metrics: best-move agreement (independent of the shield),
 * shield-intervention rate, and latency distribution (p50/p95, not just an
 * average). Consumes the same plain DecisionRecord shape as log.ts — no
 * dependency on decisions/.
 */
import type { DecisionRecord, Side } from "./log";

export interface SideMetrics {
  totalCycles: number;
  shieldInterventions: number;
  shieldInterventionRate: number | null;
  /**
   * Of cycles where a real, *unmodified* decision arrived in time, % that
   * matched the planner. Handicapped cycles are excluded from both the
   * numerator and denominator - counting a planner-substituted move as
   * "agreement" would just be measuring the handicap dial, not the model.
   */
  agreementPct: number | null;
  /** how many on-time answers were swapped for the planner's move, and what fraction of on-time answers that is */
  handicappedCount: number;
  handicapRate: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  requestsInFlight: number;
}

interface SideAccumulator {
  totalCycles: number;
  interventions: number;
  nonIntervened: number;
  handicapped: number;
  agreements: number;
  latencies: number[];
  requestsInFlight: number;
}

function emptyAccumulator(): SideAccumulator {
  return {
    totalCycles: 0,
    interventions: 0,
    nonIntervened: 0,
    handicapped: 0,
    agreements: 0,
    latencies: [],
    requestsInFlight: 0,
  };
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx] ?? null;
}

export class MetricsTracker {
  private readonly bySide: Record<Side, SideAccumulator> = {
    left: emptyAccumulator(),
    right: emptyAccumulator(),
  };

  record(rec: DecisionRecord): void {
    const acc = this.bySide[rec.side];
    acc.totalCycles += 1;
    if (rec.shieldIntervened) {
      acc.interventions += 1;
      return;
    }
    acc.nonIntervened += 1;
    if (rec.latencyMs !== null) acc.latencies.push(rec.latencyMs);
    if (rec.handicapped) {
      acc.handicapped += 1;
      return; // excluded from agreement - see SideMetrics.agreementPct
    }
    if (rec.agreedWithPlanner) acc.agreements += 1;
  }

  setRequestsInFlight(side: Side, count: number): void {
    this.bySide[side].requestsInFlight = Math.max(0, count);
  }

  getSideMetrics(side: Side): SideMetrics {
    const acc = this.bySide[side];
    const sorted = [...acc.latencies].sort((a, b) => a - b);
    const realAnswers = acc.nonIntervened - acc.handicapped;
    return {
      totalCycles: acc.totalCycles,
      shieldInterventions: acc.interventions,
      shieldInterventionRate:
        acc.totalCycles > 0 ? (acc.interventions / acc.totalCycles) * 100 : null,
      agreementPct: realAnswers > 0 ? (acc.agreements / realAnswers) * 100 : null,
      handicappedCount: acc.handicapped,
      handicapRate: acc.nonIntervened > 0 ? (acc.handicapped / acc.nonIntervened) * 100 : null,
      latencyP50: percentile(sorted, 50),
      latencyP95: percentile(sorted, 95),
      requestsInFlight: acc.requestsInFlight,
    };
  }

  reset(): void {
    this.bySide.left = emptyAccumulator();
    this.bySide.right = emptyAccumulator();
  }
}
