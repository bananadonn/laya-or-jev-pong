/**
 * Structured per-tick decision log (CLAUDE.md §3, §7). Deliberately knows
 * nothing about DecisionClient/Shield/ShieldEvent from decisions/ — main.ts
 * is responsible for turning a ShieldEvent into a plain DecisionRecord
 * before it gets here, so this module (like render/) never needs to import
 * from decisions/.
 */

export type Side = "left" | "right";
export type Move = "up" | "down" | "stay";

export interface DecisionRecord {
  side: Side;
  source: string;
  timestamp: number;
  move: Move;
  confidence: number | null;
  /** full distribution over up/down/stay, when a real decision landed */
  probabilities: Record<Move, number> | null;
  latencyMs: number | null;
  shieldIntervened: boolean;
  /** did the committed move match the deterministic planner's move this cycle */
  agreedWithPlanner: boolean;
  /** true if a real answer arrived but was swapped for the planner's move by a disclosed handicap dial */
  handicapped: boolean;
}

const DEFAULT_MAX_PER_SIDE = 500;

export class DecisionLog {
  private readonly bySide: Record<Side, DecisionRecord[]> = { left: [], right: [] };

  constructor(private readonly maxPerSide = DEFAULT_MAX_PER_SIDE) {}

  add(record: DecisionRecord): void {
    const list = this.bySide[record.side];
    list.push(record);
    if (list.length > this.maxPerSide) {
      list.splice(0, list.length - this.maxPerSide);
    }
  }

  recent(side: Side, n: number): readonly DecisionRecord[] {
    const list = this.bySide[side];
    return list.slice(Math.max(0, list.length - n));
  }

  all(side: Side): readonly DecisionRecord[] {
    return this.bySide[side];
  }

  reset(): void {
    this.bySide.left = [];
    this.bySide.right = [];
  }

  /** JSON export for replay/analysis, per CLAUDE.md §3 ("structured ... for replay/export"). */
  exportJSON(): string {
    return JSON.stringify({ left: this.bySide.left, right: this.bySide.right }, null, 2);
  }
}
