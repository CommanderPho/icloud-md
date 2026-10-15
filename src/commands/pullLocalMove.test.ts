import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { indexUntrackedNoteIds } from "../notes/untrackedFiles.js";
import { followLocalMove } from "./pull.js";
import { buildPushPlan } from "./push.js";

/**
 * Pull's half of a note moved or renamed by hand and not yet pushed: when
 * the note changes on another device meanwhile, the remote change has to
 * land in the file the note moved to. Recreating the old path instead puts
 * the original back beside the moved file, and push then reads the moved
 * file as a copy - the user's edits go up as a duplicate note.
 */

const NOTE_ID = "089D915D-C76E-4F44-AB80-2190073281A3";
const TRACKED = "Notes/Tracked.md";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-local-move-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeVaultFile(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content, "utf-8");
}

async function exists(dir: string, file: string): Promise<boolean> {
  try {
    await access(path.join(dir, file));
    return true;
  } catch {
    return false;
  }
}

function withId(body: string, extra = ""): string {
  return `---\napple-note-id: ${NOTE_ID}\n${extra}---\n\n${body}`;
}

/** The note tracked at Notes/Tracked.md, which the tests then move away. */
function trackedNotes(): CloneState["notes"] {
  return {
    [NOTE_ID]: { file: TRACKED, recordChangeTag: "1a", modificationDate: 100, folderRecordName: "DefaultFolder-CloudKit" },
  };
}

/** Index the vault exactly as pull does, then follow the missing note. */
async function follow(dir: string, remoteBody: string): ReturnType<typeof followLocalMove> {
  const index = await indexUntrackedNoteIds(dir, trackedNotes());
  return followLocalMove(dir, NOTE_ID, TRACKED, index, remoteBody);
}

test("a note renamed in place takes the remote change at its new name", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Notes/Renamed.md", withId("Synced text"));

    const outcome = await follow(dir, "Edited on the phone");

    assert.deepEqual(outcome, { kind: "followed", file: "Notes/Renamed.md", status: "updated" });
    assert.equal(await readFile(path.join(dir, "Notes/Renamed.md"), "utf-8"), withId("Edited on the phone"));
    assert.equal(await exists(dir, TRACKED), false, "the old path is not recreated beside it");
    assert.equal(await readBaseCopy(dir, NOTE_ID), "Edited on the phone");
  }));

test("a note moved to another folder and edited there gets a 3-way merge", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Title\nfirst\nsecond\nthird");
    await writeVaultFile(dir, "Recipes/Moved.md", withId("Title\nfirst LOCAL\nsecond\nthird"));

    const outcome = await follow(dir, "Title\nfirst\nsecond\nthird REMOTE");

    assert.deepEqual(outcome, { kind: "followed", file: "Recipes/Moved.md", status: "merged" });
    assert.equal(
      await readFile(path.join(dir, "Recipes/Moved.md"), "utf-8"),
      withId("Title\nfirst LOCAL\nsecond\nthird REMOTE"),
    );
    assert.equal(await exists(dir, TRACKED), false);
    // The merge ancestor going forward is the remote text, so the local half
    // still reads as an edit and goes up on the next push.
    assert.equal(await readBaseCopy(dir, NOTE_ID), "Title\nfirst\nsecond\nthird REMOTE");
  }));

test("a conflicting edit in the moved file gets markers there, and the base copy stays the ancestor", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Title\nshared line");
    await writeVaultFile(dir, "Recipes/Moved.md", withId("Title\nlocal version"));

    const outcome = await follow(dir, "Title\nremote version");

    assert.deepEqual(outcome, { kind: "followed", file: "Recipes/Moved.md", status: "conflict" });
    const text = await readFile(path.join(dir, "Recipes/Moved.md"), "utf-8");
    assert.match(text, /<<<<<<<[\s\S]*local version[\s\S]*remote version[\s\S]*>>>>>>>/);
    assert.equal(await readBaseCopy(dir, NOTE_ID), "Title\nshared line");
    assert.equal(await exists(dir, TRACKED), false);
  }));

test("the moved file's own envelope is left as the user has it, title key included", () =>
  withTempDir(async (dir) => {
    // Pull would normally strip an apple-note-title the remote doesn't need;
    // here the local move wins, so whatever the file says about its title
    // is still there for push to send.
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Notes/Renamed.md", withId("Synced text", "apple-note-title: My title\ntags: [x]\n"));

    await follow(dir, "Edited on the phone");

    assert.equal(
      await readFile(path.join(dir, "Notes/Renamed.md"), "utf-8"),
      withId("Edited on the phone", "apple-note-title: My title\ntags: [x]\n"),
    );
  }));

test("a note that's simply gone is recreated at its tracked path, as before", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Notes/Unrelated.md", "No id here");

    assert.deepEqual(await follow(dir, "Edited on the phone"), { kind: "recreate" });
    assert.equal(await readFile(path.join(dir, "Notes/Unrelated.md"), "utf-8"), "No id here");
  }));

test("two files claiming the note are left alone - the note is recreated, with a warning naming them", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Recipes/Pie.md", withId("Synced text"));
    await writeVaultFile(dir, "Recipes/Pie copy.md", withId("Synced text"));

    const outcome = await follow(dir, "Edited on the phone");

    assert.equal(outcome.kind, "recreate");
    assert.equal(outcome.kind === "recreate" ? outcome.notice?.level : undefined, "warn");
    assert.match(outcome.kind === "recreate" ? (outcome.notice?.message ?? "") : "", /Recipes\/Pie copy\.md, Recipes\/Pie\.md/);
    assert.equal(await readFile(path.join(dir, "Recipes/Pie.md"), "utf-8"), withId("Synced text"));
    assert.equal(await readFile(path.join(dir, "Recipes/Pie copy.md"), "utf-8"), withId("Synced text"));
    assert.equal(await readBaseCopy(dir, NOTE_ID), "Synced text");
  }));

test("a moved file still carrying conflict markers isn't merged into - the note is recreated, with a warning", () =>
  withTempDir(async (dir) => {
    const marked = withId("<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote\n");
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Recipes/Moved.md", marked);

    const outcome = await follow(dir, "Edited on the phone");

    assert.equal(outcome.kind, "recreate");
    assert.match(outcome.kind === "recreate" ? (outcome.notice?.message ?? "") : "", /conflict markers/);
    assert.equal(await readFile(path.join(dir, "Recipes/Moved.md"), "utf-8"), marked);
    assert.equal(await readBaseCopy(dir, NOTE_ID), "Synced text");
  }));

test("after following the move, push still plans the move rather than a create", () =>
  withTempDir(async (dir) => {
    // "Pat/" is a sharer's area, so push refuses the move locally - which is
    // what lets this prove which way the plan went without a login. Had pull
    // recreated Notes/Tracked.md, the moved file would plan as a create.
    const state: CloneState = {
      syncToken: "token",
      folders: { "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" } },
      sharerHomes: { _owner1: { name: "Pat", dirName: "Pat" } },
      notes: trackedNotes(),
    };
    await writeCloneState(dir, state);
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Pat/Moved.md", withId("Synced text"));

    await follow(dir, "Edited on the phone");
    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.previousFile, TRACKED);
    assert.equal(entries[0]?.file, "Pat/Moved.md");
  }));

test("the id index skips tracked files, id-less files, attachments, and dot-directories", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, TRACKED, withId("Still here"));
    await writeVaultFile(dir, "Notes/No id.md", "Plain");
    await writeVaultFile(dir, "Notes/attachments/Stray.md", withId("In attachments"));
    await writeVaultFile(dir, ".trash/Old.md", withId("Trashed"));
    await writeVaultFile(dir, "Recipes/Moved.md", withId("Moved"));

    const index = await indexUntrackedNoteIds(dir, trackedNotes());

    assert.deepEqual([...index], [[NOTE_ID, ["Recipes/Moved.md"]]]);
  }));
