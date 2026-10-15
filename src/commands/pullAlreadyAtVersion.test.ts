import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { CloneStateNoteEntry } from "../notes/cloneState.js";
import { isAlreadyAtTrackedVersion, type DerivedNoteFields } from "./pull.js";

// The record `push` just wrote comes straight back on the next incremental
// pull. When nothing about it differs from what the vault tracks, pull must
// leave the file alone instead of rewriting it as an "update".

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-already-at-version-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RECORD_NAME = "REC-1";

function record(recordChangeTag: string | undefined): CloudKitRecord {
  return { recordName: RECORD_NAME, recordType: "Note", fields: {}, ...(recordChangeTag !== undefined ? { recordChangeTag } : {}) };
}

function entry(overrides: Partial<CloneStateNoteEntry> = {}): CloneStateNoteEntry {
  return { file: "Notes/Groceries.md", recordChangeTag: "2b", modificationDate: 100, folderRecordName: "FOLDER-1", ...overrides };
}

function derived(overrides: Partial<DerivedNoteFields> = {}): DerivedNoteFields {
  return {
    titleLine: "Groceries",
    folderRecordName: "FOLDER-1",
    frontmatterTitle: undefined,
    unpublishableReason: undefined,
    ...overrides,
  };
}

/** A tracked note on disk whose body matches its base copy. */
async function writeCleanNote(dir: string, file: string, body: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), body, "utf-8");
  await writeBaseCopy(dir, RECORD_NAME, body);
}

test("a re-delivered record at the tracked tag, with nothing else changed, is already applied", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "in-body", {}), true);
  }));

test("local edits don't stop the skip - an incremental pull that never saw the record wouldn't touch them either", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    await writeFile(path.join(dir, "Notes/Groceries.md"), "Groceries\nmilk\neggs\n", "utf-8");
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "in-body", {}), true);
  }));

test("a different change tag is a real remote change", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("3c"), entry(), derived(), "in-body", {}), false);
  }));

test("a record with no change tag is never treated as already applied", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record(undefined), entry({ recordChangeTag: "" }), derived(), "in-body", {}),
      false,
    );
  }));

// `push`/`status` can adopt a remote change (merging its text, advancing the
// tag) without updating anything else that came with it. The re-delivery is
// what brings those fields up to date, so it must not be skipped.

test("a folder move adopted with the tag isn't skipped - the note still has to move", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived({ folderRecordName: "FOLDER-2" }), "in-body", {}),
      false,
    );
  }));

test("a changed read-only flag isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived({ unpublishableReason: "unknown embed" }), "in-body", {}),
      false,
    );
  }));

test("a changed frontmatter title isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Untitled.md", "milk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(
        dir,
        record("2b"),
        entry({ file: "Notes/Untitled.md" }),
        derived({ frontmatterTitle: "a/b" }),
        "filename",
        {},
      ),
      false,
    );
  }));

test("in a filename-as-title vault, a retitle the file name doesn't reflect yet isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "milk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived({ titleLine: "Shopping" }), "filename", {}),
      false,
    );
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "filename", {}), true);
  }));

test("a note with a rename still pending isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry({ pendingRename: "Shopping.md" }), derived(), "in-body", {}),
      false,
    );
  }));

test("a missing local file isn't skipped - pull recreates it", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, RECORD_NAME, "Groceries\nmilk\n");
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "in-body", {}), false);
  }));

test("a note with tables isn't skipped - their snapshots are taken while resolving attachments", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\nmilk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "in-body", {
        "TABLE-1": { noteRecordName: RECORD_NAME },
      }),
      false,
    );
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "in-body", {
        "TABLE-2": { noteRecordName: "SOME-OTHER-NOTE" },
      }),
      true,
    );
  }));
