import { computeHunks, mergedText, Hunk } from "./diff";
import { utf8 } from "../crypto/encoding";

export interface ConflictInput {
  id: string;
  path: string;
  isBinary: boolean;
  local: { rev: string; bytes: Uint8Array };
  remote: { rev: string; bytes: Uint8Array };
}

export class ConflictSession {
  readonly hunks: Hunk[];
  private decisions: Record<number, "local" | "remote"> = {};
  private binaryChoice: "local" | "remote" = "local";

  constructor(private readonly input: ConflictInput) {
    this.hunks = input.isBinary
      ? []
      : computeHunks(utf8.decode(input.local.bytes), utf8.decode(input.remote.bytes));
  }

  setDecision(changeIndex: number, side: "local" | "remote"): void {
    this.decisions[changeIndex] = side;
  }

  takeWhole(side: "local" | "remote"): void {
    this.binaryChoice = side;
    let changeIdx = 0;
    for (const h of this.hunks) {
      if (h.kind === "change") this.decisions[changeIdx++] = side;
    }
  }

  resultBytes(): Uint8Array {
    if (this.input.isBinary) {
      return this.binaryChoice === "local" ? this.input.local.bytes : this.input.remote.bytes;
    }
    return utf8.encode(mergedText(this.hunks, this.decisions));
  }

  /**
   * Zeilen der zusammengeführten Endfassung mit Herkunft — Grundlage der
   * Merge-Vorschau. "context" = unveränderte Zeile (in beiden gleich), "local"/
   * "remote" = aus einem Änderungsblock übernommene Zeile (je nach aktueller
   * Entscheidung). Nutzt dieselbe Auswahllogik wie resultBytes()/mergedText().
   */
  mergePreview(): Array<{ text: string; origin: "context" | "local" | "remote" }> {
    const out: Array<{ text: string; origin: "context" | "local" | "remote" }> = [];
    let changeIdx = 0;
    for (const h of this.hunks) {
      if (h.kind === "equal") {
        for (const line of h.lines) out.push({ text: line, origin: "context" });
      } else {
        const choice = this.decisions[changeIdx] ?? "local";
        for (const line of choice === "local" ? h.local : h.remote) out.push({ text: line, origin: choice });
        changeIdx++;
      }
    }
    return out;
  }

  pruneRev(): string {
    return this.input.remote.rev;
  }
}
