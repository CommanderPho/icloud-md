import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import type { CloneState, TitleMode } from "./cloneState.js";
import { splitFrontmatter } from "./frontmatter.js";
import { readNoteId } from "./noteIdFrontmatter.js";

/** Untracked `.md` files anywhere in the vault, as vault-root-relative
 * POSIX paths - the raw material for push's create half, the local-move
 * pairing, and the loose-file/unknown-folder refusals, and for pull finding
 * where a note moved by hand went. Skips dot-directories (the state dir,
 * .git) and the reserved per-folder `attachments/` directories. */
export async function listUntrackedMarkdownFiles(targetDir: string, notes: CloneState["notes"]): Promise<string[]> {
  const tracked = new Set(Object.values(notes).map((entry) => entry.file));
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(path.join(targetDir, dir), { withFileTypes: true });
    } catch (cause) {
      if (isEnoent(cause)) {
        return;
      }
      throw cause;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) {
        continue;
      }
      const relative = dir === "" ? dirent.name : `${dir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (dirent.name.toLowerCase() !== "attachments") {
          await walk(relative);
        }
      } else if (dirent.isFile() && dirent.name.endsWith(".md") && !tracked.has(relative)) {
        found.push(relative);
      }
    }
  };

  await walk("");
  return found.sort();
}

/**
 * Every untracked file that carries an `apple-note-id`, grouped by that id.
 * A file with no usable id isn't in it at all: without one, which note a
 * file is can only be guessed, and pull doesn't guess (push's content and
 * basename fallbacks are for planning a move the user then confirms by
 * pushing, not for deciding where remote text gets written).
 */
export async function indexUntrackedNoteIds(
  targetDir: string,
  notes: CloneState["notes"],
  titleMode: TitleMode = "in-body",
): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  for (const file of await listUntrackedMarkdownFiles(targetDir, notes)) {
    const raw = await readFile(path.join(targetDir, file), "utf-8");
    const noteId = readNoteId(splitFrontmatter(raw, { filenameAsTitle: titleMode === "filename" }).frontmatter);
    if (noteId === undefined) {
      continue;
    }
    const files = byId.get(noteId);
    if (files) {
      files.push(file);
    } else {
      byId.set(noteId, [file]);
    }
  }
  return byId;
}
