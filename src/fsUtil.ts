import { stat } from "node:fs/promises";

/** True if `err` is a Node "file not found" error - used by every read path
 * in this project that treats a missing file as "nothing recorded yet"
 * rather than a failure. */
export function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** True if something - file or directory - is at `filePath`. Only "not
 * found" reads as false; any other failure is rethrown. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (cause) {
    if (isEnoent(cause)) {
      return false;
    }
    throw cause;
  }
}
