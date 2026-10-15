import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// `loggedFetch` logs every request to ~/.config/icloud-md/debug.log, with the
// path fixed when `configDir.ts` loads - point HOME at a scratch dir *before*
// the dynamic imports below so this file's mocked traffic doesn't land in the
// real log. (The test runner gives each test file its own process, so the
// override can't leak into other files.)
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { fetchAllNoteRecords, fetchAllZoneRecords, fetchSharedNoteRecords } = await import("./databaseClient.js");
const { CloudKitRequestFailedError } = await import("../errors.js");

const session = {
  cookie: "cookie",
  clientId: "client-id",
  clientBuildNumber: "build",
  clientMasteringNumber: "mastering",
  capturedAt: new Date().toISOString(),
};

const host = "https://ckdatabasews.example";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function noteRecord(recordName: string, tag: string): unknown {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: tag,
    fields: { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } },
  };
}

/** One `changes/zone` response body; `syncToken` is left out when undefined. */
function zonePage(moreComing: boolean, syncToken: string | undefined, recordName: string, ownerRecordName?: string): unknown {
  const zoneID = ownerRecordName === undefined ? { zoneName: "Notes" } : { zoneName: "Notes", ownerRecordName };
  return {
    zones: [
      { zoneID, moreComing, ...(syncToken === undefined ? {} : { syncToken }), records: [noteRecord(recordName, "tag")] },
    ],
  };
}

/**
 * Serves scripted `changes/zone` responses in order and fails the test on
 * any request past the script - which is what the unguarded loop would make,
 * forever. `changes/database` (the shared zone listing) gets one owner.
 */
function installFetchMock(responses: unknown[]): { restore: () => void; zoneRequests: Record<string, unknown>[] } {
  const zoneRequests: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/shared/changes/database")) {
      return jsonResponse({
        moreComing: false,
        zones: [{ zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA", zoneType: "REGULAR_CUSTOM_ZONE" } }],
      });
    }
    if (!href.includes("/changes/zone")) {
      throw new Error(`Unexpected fetch in test: ${href}`);
    }
    const body = JSON.parse(String(init?.body)) as { zones: Record<string, unknown>[] };
    zoneRequests.push(body.zones[0] ?? {});
    const response = responses[zoneRequests.length - 1];
    if (response === undefined) {
      throw new Error(`Unexpected extra changes/zone request (#${zoneRequests.length})`);
    }
    return jsonResponse(response);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    zoneRequests,
  };
}

function isStalledPageError(error: unknown): boolean {
  return error instanceof CloudKitRequestFailedError && /moreComing without a new syncToken/.test(error.message);
}

test("an incremental walk fails loudly when a moreComing page hands back the token it was sent", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, "stored", "note-1")]);
  try {
    await assert.rejects(fetchAllNoteRecords(session, host, "12345", "stored"), isStalledPageError);
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("an incremental walk fails loudly when a moreComing page has no syncToken at all", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, undefined, "note-1")]);
  try {
    await assert.rejects(fetchAllNoteRecords(session, host, "12345", "stored"), isStalledPageError);
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("a stalled page doesn't trigger the rejected-token fallback - the token was accepted", async () => {
  // A second, token-free walk would hit this extra page; the guard must
  // propagate before it's ever requested.
  const { restore, zoneRequests } = installFetchMock([zonePage(true, "stored", "note-1"), zonePage(false, "fresh", "note-2")]);
  try {
    await assert.rejects(fetchAllNoteRecords(session, host, "12345", "stored"), isStalledPageError);
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("a full walk fails loudly when a later page repeats the previous page's token", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, "page-1", "note-1"), zonePage(true, "page-1", "note-1")]);
  try {
    await assert.rejects(fetchAllNoteRecords(session, host, "12345"), isStalledPageError);
    assert.equal(zoneRequests.length, 2);
    assert.equal(zoneRequests[1]?.syncToken, "page-1");
  } finally {
    restore();
  }
});

test("a full walk fails loudly when its first moreComing page has no syncToken", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, undefined, "note-1")]);
  try {
    await assert.rejects(fetchAllNoteRecords(session, host, "12345"), isStalledPageError);
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("a walk that advances its token on every page still pages to the end", async () => {
  const { restore, zoneRequests } = installFetchMock([
    zonePage(true, "page-1", "note-1"),
    zonePage(true, "page-2", "note-2"),
    zonePage(false, "page-3", "note-3"),
  ]);
  try {
    const result = await fetchAllNoteRecords(session, host, "12345", "stored");
    assert.deepEqual(
      result.records.map((record) => record.recordName),
      ["note-1", "note-2", "note-3"],
    );
    assert.equal(result.syncToken, "page-3");
    assert.deepEqual(
      zoneRequests.map((request) => request.syncToken),
      ["stored", "page-1", "page-2"],
    );
  } finally {
    restore();
  }
});

test("the last page may repeat or omit the token - moreComing false ends the walk either way", async () => {
  const { restore } = installFetchMock([zonePage(true, "page-1", "note-1"), zonePage(false, undefined, "note-2")]);
  try {
    const result = await fetchAllNoteRecords(session, host, "12345");
    assert.equal(result.records.length, 2);
    assert.equal(result.syncToken, "page-1");
  } finally {
    restore();
  }
});

test("a stalled shared zone is fatal, not skipped - a partial listing must not look like a clean sync", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, "stored-a", "note-a", "_ownerA")]);
  try {
    await assert.rejects(fetchSharedNoteRecords(session, host, "12345", { _ownerA: "stored-a" }), isStalledPageError);
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("fetchAllZoneRecords fails loudly on a page that repeats its token", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, "page-1", "note-1"), zonePage(true, "page-1", "note-1")]);
  try {
    await assert.rejects(fetchAllZoneRecords(session, host, "12345"), isStalledPageError);
    assert.equal(zoneRequests.length, 2);
  } finally {
    restore();
  }
});

test("fetchAllZoneRecords fails loudly on a moreComing page with no syncToken", async () => {
  const { restore, zoneRequests } = installFetchMock([zonePage(true, undefined, "note-1")]);
  try {
    await assert.rejects(fetchAllZoneRecords(session, host, "12345"), isStalledPageError);
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});
