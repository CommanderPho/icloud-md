import path from "node:path";
import { lstatIfPresent } from "../fsUtil.js";
import {
  carriedTitleSpelling,
  dropNonBmpAndJoiners,
  encodeTitleStem,
  hasNonBmpCodePoint,
  titleIsRepresentable,
  type TitlePlatformOptions,
} from "./titleFilename.js";

export interface PathSanitizeOptions extends TitlePlatformOptions {
  /** Maximum code points in the stem. Note names and folder names use 80. */
  maxLength?: number;
  /** Folders (and attachment stems) strip a trailing `.` or space, which
   * Windows rejects and which is confusing anywhere. Note names keep a
   * trailing dot so `foo.` stays `foo..md` rather than colliding with `foo`. */
  stripTrailingDotSpace?: boolean;
}

/**
 * The file name for a note, given how this vault carries titles.
 *
 * In-body mode keeps `noteFileName`'s destructive sanitizing: the name is
 * only a display convenience there, since the title also sits in the file.
 * Filename mode uses the reversible projection instead, because the name is
 * the only place the title lives - reversible up to trailing whitespace,
 * which the name drops (see `carriedTitleSpelling`) - and falls back to
 * "Untitled" for a title a name genuinely can't carry, with the real one
 * recorded in `apple-note-title` frontmatter by the caller. On Windows a
 * title whose only problem is supplementary-plane emoji gets a BMP-stripped
 * stem instead of "Untitled.md", still with frontmatter holding the real
 * title, because Node 20.4-20.11 cannot open those paths.
 */
export function noteFileNameFor(
  titleLine: string,
  titleMode: "in-body" | "filename",
  options?: TitlePlatformOptions,
): string {
  if (titleMode !== "filename") {
    return noteFileName(titleLine, options);
  }
  const firstLine = titleLine.split("\n")[0] ?? "";
  const windows = options?.windows ?? process.platform === "win32";
  if (titleIsRepresentable(firstLine, { windows })) {
    return `${encodeTitleStem(carriedTitleSpelling(firstLine))}.md`;
  }
  if (windows && hasNonBmpCodePoint(carriedTitleSpelling(firstLine))) {
    const projected = dropNonBmpAndJoiners(carriedTitleSpelling(firstLine)).replace(/\s+/g, " ").trim();
    if (titleIsRepresentable(projected, { windows: true })) {
      return `${encodeTitleStem(projected)}.md`;
    }
  }
  return "Untitled.md";
}

/**
 * The note's real title when a file name can't carry it faithfully, for the
 * caller to record in `apple-note-title` frontmatter - and undefined whenever
 * the name is enough, which is nearly always.
 *
 * Complements `noteFileNameFor`: whenever this returns a title, that
 * function filed a name that does not decode back to it ("Untitled.md", or
 * on Windows a stem with supplementary-plane characters stripped). The two
 * must never disagree about *whether* frontmatter is needed, so they stay
 * side by side and both defer to `titleIsRepresentable`.
 */
export function titleNeedingFrontmatter(
  titleLine: string,
  titleMode: "in-body" | "filename",
  options?: TitlePlatformOptions,
): string | undefined {
  if (titleMode !== "filename") {
    return undefined;
  }
  const firstLine = titleLine.split("\n")[0] ?? "";
  // An empty title is unrepresentable, but there's nothing to record: the
  // note really is untitled, so "Untitled.md" is the whole truth about it
  // and a frontmatter key holding "" would only be read back as absent.
  if (firstLine.trim() === "") {
    return undefined;
  }
  const windows = options?.windows ?? process.platform === "win32";
  return titleIsRepresentable(firstLine, { windows }) ? undefined : firstLine;
}

/**
 * Whether a file name already carries this title, in a vault where the name
 * *is* the title - either the name the title derives, or one of the
 * uniquified spellings `uniqueFileName` produces when two notes want the
 * same one.
 *
 * The uniquifier is why this can't just be a string comparison. A second
 * note titled "Foo" lands at `Foo 2.md`, whose stem decodes to "Foo 2" - so
 * comparing the decoded name against the title would call every uniquified
 * file a retitle and rename it on every pull, walking it up through "Foo 3",
 * "Foo 4"... The title a name was derived from is not always recoverable
 * from the name; whether the name is *acceptable* for the title always is,
 * and that's the question a rename decision actually asks.
 */
export function fileNameCarriesTitle(
  fileName: string,
  titleLine: string,
  options?: TitlePlatformOptions,
): boolean {
  const wanted = noteFileNameFor(titleLine, "filename", options);
  if (fileName === wanted) {
    return true;
  }
  const extension = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  if (!fileName.endsWith(extension)) {
    return false;
  }
  const actual = fileName.slice(0, fileName.length - extension.length);
  if (!actual.startsWith(`${stem} `)) {
    return false;
  }
  // Only the uniquifier's own suffixes count: " 2" onwards, digits alone.
  // A note genuinely titled "Foo 2" matches the exact comparison above
  // instead, so nothing here has to distinguish the two.
  const suffix = actual.slice(stem.length + 1);
  return /^[0-9]+$/.test(suffix) && Number(suffix) >= 2;
}

/**
 * A filesystem path segment derived from a title (or attachment stem).
 * Destructive: illegal ASCII is deleted, whitespace collapsed, and on
 * Windows supplementary-plane characters (most emoji) are dropped so Node
 * can actually open the path. Empty after sanitizing - the caller picks
 * "Untitled" / "Untitled Folder".
 */
export function sanitizeDisplayStem(title: string, options?: PathSanitizeOptions): string {
  const windows = options?.windows ?? process.platform === "win32";
  const maxLength = options?.maxLength ?? 80;
  let slug = title.split("\n")[0] ?? "";
  if (windows) {
    slug = dropNonBmpAndJoiners(slug);
  }
  slug = slug
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Leftover C0 / DEL after whitespace collapse. Tabs and newlines already
    // became spaces; the rest (e.g. U+0001) are illegal on Windows and never
    // useful in a path.
    .replace(/[\u0000-\u001F\u007F]/g, "");
  slug = [...slug].slice(0, maxLength).join("");
  if (options?.stripTrailingDotSpace) {
    slug = slug.replace(/[. ]+$/, "");
  }
  return slug;
}

/**
 * Derives a human-readable file name for a note from its title alone. The
 * CloudKit recordName that used to be suffixed onto every file for
 * uniqueness now lives only in .icloud-md/state.json (keyed by
 * recordName, with a `file` pointer back to disk) - see uniqueFileName for
 * how title collisions are disambiguated instead.
 */
export function noteFileName(title: string, options?: PathSanitizeOptions): string {
  const slug = sanitizeDisplayStem(title, options);
  const base = slug.length > 0 ? slug : "Untitled";
  return `${base}.md`;
}

/**
 * An attachment's on-disk basename: same character rules as a folder name
 * (including the Windows non-BMP strip), extension preserved. Already-tracked
 * attachment paths are not re-derived; this is only for new files.
 */
export function sanitizeAttachmentFileName(fileName: string, options?: PathSanitizeOptions): string {
  const ext = path.extname(fileName);
  const rawStem = fileName.slice(0, fileName.length - ext.length);
  const stem = sanitizeDisplayStem(rawStem, { ...options, stripTrailingDotSpace: true });
  const safeExt = ext.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, "");
  const base = stem.length > 0 ? stem : "Untitled";
  return `${base}${safeExt}`;
}

/**
 * Resolves a candidate file name against names already claimed in this
 * clone/pull run, appending " 2", " 3", etc. (Finder-style) until it's
 * unique. Needed now that file names are derived from title alone, so two
 * notes titled e.g. "New Note" no longer collide.
 */
export function uniqueFileName(fileName: string, usedFileNames: ReadonlySet<string>): string {
  if (!usedFileNames.has(fileName)) {
    return fileName;
  }

  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);

  let n = 2;
  let candidate = `${stem} ${n}${ext}`;
  while (usedFileNames.has(candidate)) {
    n += 1;
    candidate = `${stem} ${n}${ext}`;
  }
  return candidate;
}

/**
 * `uniqueFileName` for a name about to be written into `dirPath`: also steers
 * clear of anything already on disk there, then claims the result in
 * `usedFileNames`. Tracked names alone aren't enough wherever pull writes or
 * moves a file - a file the user created and hasn't pushed is untracked, and
 * a plain `writeFile`/`rename` onto its name destroys it. Names found taken on
 * disk are claimed too, so later calls in the same run skip them without
 * another stat.
 *
 * `ownPath` is the file being moved or renamed, when there is one. A
 * candidate that turns out to *be* that file isn't taken: on a
 * case-insensitive filesystem (APFS, NTFS) a case-only change - folder
 * "recipes" retitled "Recipes", note "groceries" retitled "Groceries" -
 * resolves the new name to the very file being moved, and counting that as
 * a collision would give it a needless " 2" suffix. Identity is device plus
 * inode, so the check doesn't need to know how the filesystem folds case.
 * The two paths must also differ only by case, though: a real hard link
 * under another name is the same inode too, but `rename()` between two links
 * of one file does nothing, which would leave the old name behind as an
 * untracked copy - so a hard link counts as taken like any other file.
 */
export async function claimFreeFileName(
  dirPath: string,
  fileName: string,
  usedFileNames: Set<string>,
  ownPath?: string,
): Promise<string> {
  const own = ownPath === undefined ? undefined : await lstatIfPresent(ownPath);
  let candidate = uniqueFileName(fileName, usedFileNames);
  for (;;) {
    const candidatePath = path.join(dirPath, candidate);
    const found = await lstatIfPresent(candidatePath);
    if (found === undefined) {
      break;
    }
    if (
      own !== undefined &&
      ownPath !== undefined &&
      found.dev === own.dev &&
      found.ino === own.ino &&
      foldCase(candidatePath) === foldCase(ownPath)
    ) {
      break;
    }
    usedFileNames.add(candidate);
    candidate = uniqueFileName(fileName, usedFileNames);
  }
  usedFileNames.add(candidate);
  return candidate;
}

/** A path as a case- and normalization-insensitive filesystem would compare
 * it, close enough to tell a case-only alias of a file from a hard link under
 * a genuinely different name. */
function foldCase(filePath: string): string {
  return filePath.normalize("NFC").toLowerCase();
}
