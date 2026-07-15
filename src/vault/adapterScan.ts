export interface ListingAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export async function listAllFiles(adapter: ListingAdapter, root = ""): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const { files, folders } = await adapter.list(dir);
    out.push(...files);
    stack.push(...folders);
  }
  return out;
}
