export interface SyncRules {
  syncHidden: boolean;
  include: string[];
  exclude: string[];
}

// Nie synchronisieren (nicht abschaltbar): Vaultbridge' eigenes Verzeichnis.
const HARD_EXCLUDE = [".obsidian/plugins/vaultbridge/**", "*.vaultbridge-konflikt", "**/*.vaultbridge-konflikt"];

export const DEFAULT_RULES: SyncRules = {
  syncHidden: true,
  include: [
    ".claude/**",
    ".obsidian/plugins/**",
    ".obsidian/snippets/**",
    ".obsidian/themes/**",
    ".obsidian/community-plugins.json",
    ".obsidian/appearance.json",
    ".obsidian/hotkeys.json",
  ],
  exclude: [
    ".obsidian/workspace*.json",
    ".obsidian/graph.json",
    ".trash/**",
    ".git/**",
    "node_modules/**",
    ".DS_Store",
  ],
};

export function isHidden(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith("."));
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(path));
}

export function shouldSync(path: string, rules: SyncRules): boolean {
  if (matchesAny(path, HARD_EXCLUDE)) return false;
  if (matchesAny(path, rules.exclude)) return false;
  if (isHidden(path)) {
    return rules.syncHidden && matchesAny(path, rules.include);
  }
  return true;
}
