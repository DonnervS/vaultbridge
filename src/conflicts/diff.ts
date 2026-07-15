import { diffLines } from "diff";

export type Hunk =
  | { kind: "equal"; lines: string[] }
  | { kind: "change"; local: string[]; remote: string[] };

function toLines(value: string): string[] {
  if (value === "") return [];
  // Zeilen INKLUSIVE ihres abschließenden \n behalten, damit die Rekonstruktion
  // (join("")) byte-exakt ist und ein Datei-Abschluss-\n nicht verloren geht.
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
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
  return out.join("");
}

export function wholeSide(hunks: Hunk[], side: "local" | "remote"): string {
  const decisions: Record<number, "local" | "remote"> = {};
  let i = 0;
  for (const h of hunks) {
    if (h.kind === "change") decisions[i++] = side;
  }
  return mergedText(hunks, decisions);
}
