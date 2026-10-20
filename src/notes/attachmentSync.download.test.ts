import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmbedSlot } from "./noteAttachments.js";

type TestRecord = {
  recordName: string;
  recordType: string;
  fields: Record<string, { value: unknown; type: string }>;
};

// Point HOME at a scratch dir before the dynamic imports below, so this
// file's mocked traffic doesn't land in the real debug log (see
// databaseClient.assetBody.test.ts).
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { resolveNoteAttachments } = await import("./attachmentSync.js");
const { formatEmbedMarker } = await import("./unknownContent.js");

const session = {
  cookie: "cookie",
  clientId: "client-id",
  clientBuildNumber: "build",
  clientMasteringNumber: "mastering",
  capturedAt: new Date().toISOString(),
};
const HOST = "https://ckdatabasews.example";
const auth = { session, ckdatabasewsUrl: HOST, dsid: "12345" };

const ATTACHMENT_ID = "7ED80274-4400-4C02-87EA-F542F056FF02";
const MEDIA_ID = "066C8A2E-796F-403F-AD75-A5267CBD0E18";
const NOTE_ID = "NOTE2";
const STALE_URL = "https://cvws.icloud-content.com/B/image-asset";
const FRESH_URL = "https://cvws.icloud-content.com/B/image-asset-fresh";
const BYTES = Buffer.from("jpeg-bytes");

const ATTACHMENT_RECORD: TestRecord = {
  recordName: ATTACHMENT_ID,
  recordType: "Attachment",
  fields: {
    UTI: { value: "public.jpeg", type: "STRING" },
    Media: {
      value: { recordName: MEDIA_ID, action: "VALIDATE" },
      type: "REFERENCE",
    },
  },
};

function mediaRecord(downloadURL: string): TestRecord {
  return {
    recordName: MEDIA_ID,
    recordType: "Media",
    fields: {
      Asset: {
        value: {
          fileChecksum: "ARKf/Vy+irL9d80LorfL6M0D7FG5",
          size: BYTES.length,
          downloadURL,
        },
        type: "ASSETID",
      },
      FilenameEncrypted: { value: "XzcxMzAwOTMuanBlZw==", type: "ENCRYPTED_BYTES" },
    },
  };
}

const SLOTS: EmbedSlot[] = [{ kind: "attachment", ref: { attachmentIdentifier: ATTACHMENT_ID, typeUti: "public.jpeg" } }];
const BODY = "Title\n\uFFFC\n";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface FetchMock {
  restore: () => void;
  assetDownloads: string[];
  lookups: number;
}

function installFetchMock(options: {
  /** Media record returned on the first Media lookup (the batch after Attachments). */
  listedMedia?: TestRecord | undefined;
  /** Media record returned on a later lookup (the stale-URL retry). Defaults to listedMedia. */
  retryMedia?: TestRecord | undefined;
  assetResponse: (url: string) => Response;
}): FetchMock {
  const realFetch = globalThis.fetch;
  const state: FetchMock = { restore: () => {}, assetDownloads: [], lookups: 0 };
  let mediaLookups = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/private/records/lookup")) {
      state.lookups += 1;
      const request = JSON.parse(String(init?.body)) as { records: Array<{ recordName: string }> };
      const records: TestRecord[] = [];
      for (const { recordName } of request.records) {
        if (recordName === ATTACHMENT_ID) {
          records.push(ATTACHMENT_RECORD);
          continue;
        }
        if (recordName === MEDIA_ID) {
          mediaLookups += 1;
          const media = mediaLookups === 1 ? options.listedMedia : (options.retryMedia ?? options.listedMedia);
          if (media) {
            records.push(media);
          }
        }
      }
      return jsonResponse({ records });
    }
    if (href.startsWith("https://cvws.icloud-content.com/")) {
      state.assetDownloads.push(href);
      return options.assetResponse(href);
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  state.restore = () => {
    globalThis.fetch = realFetch;
  };
  return state;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "attachmentsync-download-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function resolveIn(dir: string) {
  return resolveNoteAttachments(auth, "private", { zoneName: "Notes" }, dir, NOTE_ID, BODY, SLOTS, {}, {}, new Set(), "");
}

test("resolveNoteAttachments re-looks-up the Media record for a fresh URL when the first download fails", () =>
  withTempDir(async (dir) => {
    const mock = installFetchMock({
      listedMedia: mediaRecord(STALE_URL),
      retryMedia: mediaRecord(FRESH_URL),
      assetResponse: (url) =>
        url === FRESH_URL
          ? new Response(new Uint8Array(BYTES), { status: 200 })
          : new Response("expired", { status: 400 }),
    });
    try {
      const result = await resolveIn(dir);

      assert.deepEqual(mock.assetDownloads, [STALE_URL, FRESH_URL]);
      assert.equal(mock.lookups, 3);
      assert.equal(result.notices.length, 0);
      assert.equal(result.bodyText, "Title\n![_7130093.jpeg](attachments/_7130093.jpeg)\n");
      assert.equal(result.attachments[ATTACHMENT_ID]?.file, "attachments/_7130093.jpeg");
      assert.equal(await readFile(path.join(dir, "attachments", "_7130093.jpeg"), "utf-8"), "jpeg-bytes");
    } finally {
      mock.restore();
    }
  }));

test("resolveNoteAttachments degrades a download that fails twice to an embed marker instead of throwing", () =>
  withTempDir(async (dir) => {
    const mock = installFetchMock({
      listedMedia: mediaRecord(STALE_URL),
      retryMedia: mediaRecord(FRESH_URL),
      assetResponse: () => new Response("gone", { status: 400 }),
    });
    try {
      const result = await resolveIn(dir);

      assert.deepEqual(mock.assetDownloads, [STALE_URL, FRESH_URL]);
      assert.deepEqual(result.attachments, {});
      assert.equal(result.bodyText, `Title\n${formatEmbedMarker({ attachmentIdentifier: ATTACHMENT_ID, typeUti: "public.jpeg" })}\n`);
      assert.equal(result.notices.length, 1);
      assert.equal(result.notices[0]?.level, "warn");
      assert.match(result.notices[0]?.message ?? "", new RegExp(`attachment ${ATTACHMENT_ID}`));
      assert.match(result.notices[0]?.message ?? "", new RegExp(`note ${NOTE_ID}`));
      assert.match(result.notices[0]?.message ?? "", /HTTP 400/);
    } finally {
      mock.restore();
    }
  }));

test("resolveNoteAttachments skips the GET when the destination file already exists at the Asset size", () =>
  withTempDir(async (dir) => {
    await mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeFile(path.join(dir, "attachments", "_7130093.jpeg"), BYTES);
    const mock = installFetchMock({
      listedMedia: mediaRecord(STALE_URL),
      assetResponse: () => {
        throw new Error("should not re-download a file that is already the right size");
      },
    });
    try {
      const result = await resolveIn(dir);

      assert.deepEqual(mock.assetDownloads, []);
      assert.equal(result.notices.length, 0);
      assert.equal(result.bodyText, "Title\n![_7130093.jpeg](attachments/_7130093.jpeg)\n");
      assert.equal(result.attachments[ATTACHMENT_ID]?.file, "attachments/_7130093.jpeg");
    } finally {
      mock.restore();
    }
  }));

test("resolveNoteAttachments re-downloads when a leftover file's size does not match the Asset", () =>
  withTempDir(async (dir) => {
    await mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeFile(path.join(dir, "attachments", "_7130093.jpeg"), "stale");
    const mock = installFetchMock({
      listedMedia: mediaRecord(STALE_URL),
      assetResponse: () => new Response(new Uint8Array(BYTES), { status: 200 }),
    });
    try {
      const result = await resolveIn(dir);

      assert.deepEqual(mock.assetDownloads, [STALE_URL]);
      assert.equal(await readFile(path.join(dir, "attachments", "_7130093.jpeg"), "utf-8"), "jpeg-bytes");
      assert.equal(result.attachments[ATTACHMENT_ID]?.file, "attachments/_7130093.jpeg");
    } finally {
      mock.restore();
    }
  }));
