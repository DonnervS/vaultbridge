import { diffLines } from "diff";

export type Hunk =
  | { kind: "equal"; lines: string[] }
  | { kind: "change"; local: string[]; remote: string[] };

function toLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // Artefakt eines abschließenden \n
  return lines;
}

export function computeHunks(localText: string, remoteText: string): Hunk[] {
  const parts = diffLines(localText, remoteText);
  const hunks: Hunk[] = [];
  let pendLocal: string[] = [];
  let pendRemote: string[] = [];
  const flush = () => {
    if (pendLocal.length || pendRemote.length) {
      hunks.push({ kind: "change", local: pendLocal, remote: pendRemote });
      pendLocal = [];
      pendRemote = [];
    }
  };
  for (const part of parts) {
    const lines = toLines(part.value);
    if (part.added) {
      pendRemote.push(...lines);
    } else if (part.removed) {
      pendLocal.push(...lines);
    } else {
      flush();
      if (lines.length) hunks.push({ kind: "equal", lines });
    }
  }
  flush();
  return hunks;
}

export function mergedText(
  hunks: Hunk[],
  decisions: Record<number, "local" | "remote">,
): string {
  const out: string[] = [];
  let changeIdx = 0;
  for (const h of hunks) {
    if (h.kind === "equal") {
      out.push(...h.lines);
    } else {
      const choice = decisions[changeIdx] ?? "local";
      out.push(...(choice === "local" ? h.local : h.remote));
      changeIdx++;
    }
  }
  return out.join("\n");
}

export function wholeSide(hunks: Hunk[], side: "local" | "remote"): string {
  const out: string[] = [];
  for (const h of hunks) {
    if (h.kind === "equal") out.push(...h.lines);
    else out.push(...(side === "local" ? h.local : h.remote));
  }
  return out.join("\n");
}
