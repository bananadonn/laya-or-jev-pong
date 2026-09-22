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
  /** of cycles where a real decision arrived in time, % that matched the planner */
  agreementPct: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  requestsInFlight: number;
}

interface SideAccumulator {
  totalCycles: number;
  interventions: number;
  nonIntervened: number;
  agreements: number;
  latencies: number[];
  requestsInFlight: number;
}

function emptyAccumulator(): SideAccumulator {
  return {
    totalCycles: 0,
    interventions: 0,
    nonIntervened: 0,
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
    } else {
      acc.nonIntervened += 1;
      if (rec.agreedWithPlanner) acc.agreements += 1;
      if (rec.latencyMs !== null) acc.latencies.push(rec.latencyMs);
    }
  }

  setRequestsInFlight(side: Side, count: number): void {
    this.bySide[side].requestsInFlight = Math.max(0, count);
  }

  getSideMetrics(side: Side): SideMetrics {
    const acc = this.bySide[side];
    const sorted = [...acc.latencies].sort((a, b) => a - b);
    return {
      totalCycles: acc.totalCycles,
      shieldInterventions: acc.interventions,
      shieldInterventionRate:
        acc.totalCycles > 0 ? (acc.interventions / acc.totalCycles) * 100 : null,
      agreementPct: acc.nonIntervened > 0 ? (acc.agreements / acc.nonIntervened) * 100 : null,
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
