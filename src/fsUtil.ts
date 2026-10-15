import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";

/** True if `err` is a Node "file not found" error - used by every read path
 * in this project that treats a missing file as "nothing recorded yet"
 * rather than a failure. */
export function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** What is at `filePath` - file, directory, or a symlink itself (dangling or
 * not; links aren't followed) - or undefined if nothing is. Only "not found"
 * reads as undefined; any other failure is rethrown. */
export async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (cause) {
    if (isEnoent(cause)) {
      return undefined;
    }
    throw cause;
  }
}
