import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDebugLogSince } from "../debugLog.js";
import { runClone, skipFailedCloneRecord, type CloneSummary } from "./clone.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";

function emptySummary(): CloneSummary {
  return {
    written: 0,
    writtenShared: 0,
    writtenUnpublishable: 0,
    attachmentsDownloaded: 0,
    skippedDeleted: 0,
    skippedUndecodable: 0,
    skippedFailed: 0,
    notices: [],
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "clone-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("clone refuses to run against an already-cloned folder, without attempting to authenticate", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      account: { appleId: "me@example.com", dsid: "1234" },
      syncToken: "token",
      notes: {},
    };
    await writeCloneState(dir, state);

    await assert.rejects(runClone(dir), /is already a cloned notes directory/);
  }));

test("skipFailedCloneRecord records the note and writes a debug-log line without rethrowing", () =>
  withTempDir(async (dir) => {
    const logPath = path.join(dir, "debug.log");
    const summary = emptySummary();
    const error = new Error("ENOENT: no such file or directory, open 'Notes/Weird.md'");

    await skipFailedCloneRecord(summary, "REC-1", error, {
      relativeFile: "Notes/Weird.md",
      debugLogPath: logPath,
    });

    assert.equal(summary.skippedFailed, 1);
    assert.equal(summary.notices.length, 1);
    assert.equal(summary.notices[0]?.level, "warn");
    assert.match(summary.notices[0]?.message ?? "", /Skipped note REC-1 \(Notes\/Weird\.md\): ENOENT/);

    const records = await readDebugLogSince(new Date(0), logPath);
    assert.equal(records.length, 1);
    assert.match(records[0]?.note ?? "", /clone: skipped note REC-1 \(Notes\/Weird\.md\): ENOENT/);
    assert.match(records[0]?.note ?? "", /Error: ENOENT/);
  }));

test("skipFailedCloneRecord still logs when no path is known yet", () =>
  withTempDir(async (dir) => {
    const logPath = path.join(dir, "debug.log");
    const summary = emptySummary();

    await skipFailedCloneRecord(summary, "REC-2", "disk full", { debugLogPath: logPath });

    assert.equal(summary.skippedFailed, 1);
    assert.equal(summary.notices[0]?.message, "Skipped note REC-2: disk full");
    const records = await readDebugLogSince(new Date(0), logPath);
    assert.equal(records[0]?.note, "clone: skipped note REC-2: disk full");
  }));
