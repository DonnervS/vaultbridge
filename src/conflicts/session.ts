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

  pruneRev(): string {
    return this.input.remote.rev;
  }
}
