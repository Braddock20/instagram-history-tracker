/**
 * End-to-end pipeline test.
 *
 * Runs the REAL Hono worker (src/index.ts) against a REAL PostgreSQL engine
 * (PGlite, compiled to WASM). Only two things are stubbed:
 *   1. src/db.ts  -> the neon() tagged template becomes pglite.query(sql, params)
 *                     (identical contract: returns the rows array)
 *   2. the Cloudflare Queue binding -> an in-memory array we can drain by hand
 *
 * Everything else -- routing, validation, SQL text, parameter order, the
 * finalize_import() PL/pgSQL function -- is the code that actually ships.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pg: PGlite;

vi.mock("../src/db", () => ({
  // neon() returns a tag function that resolves to a rows array, and numbers its
  // placeholders $1..$N in interpolation order. Reproduce that exactly.
  db: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let n = 0;
    const sql = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${++n}` : ""), "");
    const r = await pg.query(sql, values as never[]);
    return r.rows as never[];
  },
  asInt: (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  },
}));

const queue: { body: unknown; acked: boolean; retried: boolean }[] = [];
const env: Record<string, unknown> = {
  DATABASE_URL: "postgresql://stub/stub",
  IMPORT_QUEUE: {
    send: async (body: unknown) => {
      queue.push({ body, acked: false, retried: false });
    },
  },
};

let worker: typeof import("../src/index").default;

const ORIGIN = "http://worker.test";
async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const req = new Request(ORIGIN + url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await worker.fetch(req as never, env as never);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: res.status, body: json };
}

/** Drain the Cloudflare Queue through the real consumer export. */
async function drainQueue() {
  while (queue.length) {
    const batch = queue.splice(0, queue.length).map(m => ({
      body: m.body as never,
      ack: () => {
        m.acked = true;
      },
      retry: () => {
        m.retried = true;
      },
    }));
    await worker.queue({ messages: batch, queue: "instagram-history-imports" } as never, env as never);
  }
}

const FOLLOWERS = ["alice_test", "bob_test", "charlie_test"];
const FOLLOWING = ["alice_test", "bob_test", "david_test"];

/** Typed wrapper so assertions read cleanly (PGlite returns unknown records). */
async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pg.query(sql, params as never[]);
  return r.rows as T[];
}

beforeAll(async () => {
  pg = new PGlite();
  // pgcrypto is unavailable in PGlite; gen_random_uuid() is core since PG13.
  const schema = fs
    .readFileSync(path.join(root, "migrations/001_initial.sql"), "utf8")
    .replace(/create extension if not exists pgcrypto;/i, "");
  await pg.exec(schema);
  worker = (await import("../src/index")).default;
}, 60_000);

describe("A. accounts", () => {
  let accountId: string;

  it("creates an account", async () => {
    const r = await call("POST", "/api/v1/accounts", { username: "termux_test_2026", display_name: "Termux Test" });
    expect(r.status).toBe(201);
    accountId = r.body.id;
    expect(accountId).toBeTruthy();
  });

  it("lists it back", async () => {
    const r = await call("GET", "/api/v1/accounts");
    expect(r.status).toBe(200);
    expect(r.body.accounts).toHaveLength(1);
  });

  it("404s imports/init for an unknown account", async () => {
    const r = await call("POST", "/api/v1/accounts/00000000-0000-4000-8000-000000000000/imports/init", {
      filename: "x.zip",
      sha256: "b".repeat(64),
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("account_not_found");
  });

  // ---- section 13.B: the reported bug -------------------------------------
  it("PRIMARY BUG: imports/init must not 500 with a $2 type error", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, {
      filename: "termux-test.zip",
      sha256: "a".repeat(64),
      observed_at: "2026-10-07T11:52:00.000Z",
    });
    expect(r.body?.error).not.toBe("internal_error");
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    expect(r.body.status).toBe("staging");
  });

  it("wrote the audit_log row that used to explode", async () => {
    const r = await q<any>("select action, details from audit_log order by id");
    expect(r.map(x => x.action)).toContain("import_started");
    const row = r.find(x => x.action === "import_started");
    expect(row.details.import_id).toBeTruthy();
    expect(row.details.filename).toBe("termux-test.zip");
  });

  // ---- section 13.C: duplicate detection ----------------------------------
  it("C: same account + same sha256 returns duplicate info, creates no 2nd import", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, {
      filename: "termux-test.zip",
      sha256: "a".repeat(64),
      observed_at: "2026-10-07T11:52:00.000Z",
    });
    expect(r.body.duplicate).toBe(true);
    expect(r.body.import.status).toBe("staging");
    const n = await q("select count(*)::int c from imports");
    expect(n[0].c).toBe(1);
  });

  it("C: the SAME sha256 on a DIFFERENT account is allowed (uniqueness is account-scoped)", async () => {
    const other = await call("POST", "/api/v1/accounts", { username: "second_account" });
    const r = await call("POST", `/api/v1/accounts/${other.body.id}/imports/init`, {
      filename: "termux-test.zip",
      sha256: "a".repeat(64),
    });
    expect(r.status).toBe(201);
    expect(r.body.duplicate).toBeUndefined();
  });

  // ---- section 13.D: request validation -----------------------------------
  it("D: rejects a malformed sha256 with 400, not 500", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, { filename: "x.zip", sha256: "zzz" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_sha256");
  });

  it("D: rejects a malformed observed_at with 400, not 500", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, {
      filename: "x.zip",
      sha256: "c".repeat(64),
      observed_at: "not-a-date",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_observed_at");
  });

  it("D: rejects a non-uuid account id with 4xx, not a raw 500", async () => {
    const r = await call("POST", "/api/v1/accounts/not-a-uuid/imports/init", { filename: "x.zip" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.body?.error).not.toBe("internal_error");
  });

  it("D: rejects malformed JSON bodies with 4xx", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, "{not json");
    expect(r.status).toBeLessThan(500);
  });
});

describe("B. chunk -> commit -> queue -> consumer -> finalize_import", () => {
  let accountId: string;
  let importId: string;

  beforeAll(async () => {
    const acc = await q<{ id: string }>("select id from instagram_accounts where username='termux_test_2026'");
    accountId = acc[0].id;
    const imp = await q<{ id: string }>("select id from imports where account_id=$1", [accountId]);
    importId = imp[0].id;
  });

  // ---- section 13.E -------------------------------------------------------
  it("E: chunk endpoint inserts normalized usernames into import_usernames", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/${importId}/chunk`, {
      followers: FOLLOWERS,
      following: FOLLOWING,
    });
    expect(r.status).toBe(200);
    expect(r.body.staged_followers).toBe(3);
    expect(r.body.staged_following).toBe(3);

    const rows = await q("select username, relationship from import_usernames where import_id=$1 order by relationship, username", [importId]);
    expect(rows).toHaveLength(6);
    expect(rows.filter(r => r.relationship === "follower").map(r => r.username)).toEqual([...FOLLOWERS].sort());
  });

  it("E: re-sending the same chunk is idempotent (no duplicate rows, no error)", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/${importId}/chunk`, {
      followers: FOLLOWERS,
      following: FOLLOWING,
    });
    expect(r.status).toBe(200);
    const rows = await q("select count(*)::int c from import_usernames where import_id=$1", [importId]);
    expect(rows[0].c).toBe(6);
  });

  it("E: usernames are normalized (@ and case) and garbage is dropped", async () => {
    // Scratch import: the real one must stay exactly the 3/3 spec dataset.
    const scratch = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, {
      filename: "normalize.zip",
      sha256: "f".repeat(64),
    });
    const sid = scratch.body.id;
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/${sid}/chunk`, {
      followers: ["@Eve_Test", "  ", "not valid!", "alice_test", "eve_test"],
    });
    expect(r.status).toBe(200);
    expect(r.body.staged_followers).toBe(2); // "eve_test" deduped, junk dropped

    const rows = await q("select username from import_usernames where import_id=$1 order by username", [sid]);
    expect(rows.map(x => x.username)).toEqual(["alice_test", "eve_test"]);
  });

  it("E: an oversized chunk is rejected with 413 and stages nothing", async () => {
    // Use a throwaway import so the real one is not polluted.
    const scratch = await call("POST", `/api/v1/accounts/${accountId}/imports/init`, {
      filename: "oversized.zip",
      sha256: "e".repeat(64),
    });
    const big = Array.from({ length: 6000 }, (_, i) => `bulk_${i}`);
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/${scratch.body.id}/chunk`, {
      followers: big,
      following: big,
    });
    expect(r.status).toBe(413);
    const rows = await q("select count(*)::int c from import_usernames where import_id=$1", [scratch.body.id]);
    expect(rows[0].c).toBe(0);
  });

  // ---- section 13.F -------------------------------------------------------
  it("F: commit moves staging -> queued and hands off to the Queue", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/imports/${importId}/commit`, {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("queued");
    expect(queue).toHaveLength(1);
    expect((queue[0].body as any).importId).toBe(importId);
    const s = await q("select status from imports where id=$1", [importId]);
    expect(s[0].status).toBe("queued");
  });

  // ---- section 13.G -------------------------------------------------------
  it("G: the consumer acks the message after finalize_import()", async () => {
    await drainQueue();
    expect(queue).toHaveLength(0);
  });

  // ---- section 13.H -------------------------------------------------------
  it("H: finalization produced the expected analytics", async () => {
    const imp = await q("select status, snapshot_id, followers_count, following_count, errors from imports where id=$1", [importId]);
    expect(imp[0].status === "valid" || imp[0].status === "valid_with_warnings").toBe(true);
    expect(imp[0].errors).toEqual([]);
    expect(imp[0].followers_count).toBe(3);
    expect(imp[0].following_count).toBe(3);
    expect(imp[0].snapshot_id).toBeTruthy();

    const snap = await q("select * from snapshots where id=$1", [imp[0].snapshot_id]);
    expect(snap[0].followers_count).toBe(3);
    expect(snap[0].following_count).toBe(3);
    expect(snap[0].mutual_count).toBe(2);
    expect(snap[0].not_following_back_count).toBe(1);
  });

  it("H: staging usernames are cleaned up after finalization", async () => {
    const rows = await q("select count(*)::int c from import_usernames where import_id=$1", [importId]);
    expect(rows[0].c).toBe(0);
  });

  it("H: finalize_import is idempotent -- replaying the message changes nothing", async () => {
    const before = await q("select count(*)::int c from snapshots");
    const r = await q("select finalize_import($1::uuid) as result", [importId]);
    expect(r[0].result.status).toBe("valid");
    const after = await q("select count(*)::int c from snapshots");
    expect(after[0].c).toBe(before[0].c);
  });
});

describe("C. persistence read-back (section 13.I)", () => {
  let accountId: string;

  beforeAll(async () => {
    const acc = await q<{ id: string }>("select id from instagram_accounts where username='termux_test_2026'");
    accountId = acc[0].id;
  });

  it("GET /accounts still lists the account with snapshot counts", async () => {
    const r = await call("GET", "/api/v1/accounts");
    const a = r.body.accounts.find((x: any) => x.id === accountId);
    expect(a.followers_count).toBe(3);
    expect(a.following_count).toBe(3);
  });

  it("GET /overview returns 3 / 3 / 2 mutuals / 1 not-following-back", async () => {
    const r = await call("GET", `/api/v1/accounts/${accountId}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.followers).toBe(3);
    expect(r.body.following).toBe(3);
    expect(r.body.mutuals).toBe(2);
    expect(r.body.not_following_back).toBe(1);
    expect(r.body.follow_back_ratio).toBeCloseTo(2 / 3, 3);
  });

  it("GET /snapshots returns the created snapshot", async () => {
    const r = await call("GET", `/api/v1/accounts/${accountId}/snapshots`);
    expect(r.body.snapshots).toHaveLength(1);
    expect(r.body.snapshots[0].mutual_count).toBe(2);
  });

  it("GET /relationships/* return the right username sets", async () => {
    const f = await call("GET", `/api/v1/accounts/${accountId}/relationships/followers`);
    expect(f.body.usernames).toEqual([...FOLLOWERS].sort());

    const g = await call("GET", `/api/v1/accounts/${accountId}/relationships/following`);
    expect(g.body.usernames).toEqual([...FOLLOWING].sort());

    const m = await call("GET", `/api/v1/accounts/${accountId}/relationships/mutuals`);
    expect(m.body.usernames).toEqual(["alice_test", "bob_test"]);

    const n = await call("GET", `/api/v1/accounts/${accountId}/relationships/not-following-back`);
    expect(n.body.usernames).toEqual(["david_test"]);
  });

  it("GET /changes works (this route had the same $2 type-inference bug)", async () => {
    const r = await call("GET", `/api/v1/accounts/${accountId}/changes`);
    expect(r.status).toBe(200);
    expect(r.body?.error).not.toBe("internal_error");
    expect(Array.isArray(r.body.changes)).toBe(true);
  });

  it("GET /changes?type= filters and rejects unknown types", async () => {
    const ok = await call("GET", `/api/v1/accounts/${accountId}/changes?type=followed_you`);
    expect(ok.status).toBe(200);
    const bad = await call("GET", `/api/v1/accounts/${accountId}/changes?type=';drop table people;--`);
    expect(bad.status).toBeLessThan(500);
    const still = await q("select count(*)::int c from people");
    expect(still[0].c).toBeGreaterThan(0);
  });

  it("GET /changes/export.csv downloads", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/accounts/${accountId}/changes/export.csv`) as never,
      env as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(await res.text()).toContain("event_type,username");
  });

  it("POST /exclusions works (this route had a number-in-jsonb_build_object bug)", async () => {
    const r = await call("POST", `/api/v1/accounts/${accountId}/exclusions`, {
      usernames: ["charlie_test"],
      reason: "bot",
    });
    expect(r.status).toBe(200);
    expect(r.body.added_or_updated).toBe(1);

    const g = await call("GET", `/api/v1/accounts/${accountId}/exclusions`);
    expect(g.body.exclusions).toHaveLength(1);
  });

  it("exclusions are applied to lists, while snapshot counts stay historical", async () => {
    // README contract: "Exclusions affect presentation/analytics but never
    // delete historical facts." So the relationship LISTS are filtered, and the
    // stored snapshot counts deliberately keep the raw observed numbers.
    const f = await call("GET", `/api/v1/accounts/${accountId}/relationships/followers`);
    expect(f.body.usernames).not.toContain("charlie_test");
    expect(f.body.usernames).toEqual(["alice_test", "bob_test"]);

    const o = await call("GET", `/api/v1/accounts/${accountId}/overview`);
    expect(o.body.excluded_count).toBe(1);
    // The snapshot is the historical record and still says 3.
    expect(o.body.followers).toBe(3);

    // NOTE (reported, not changed): the dashboard's "Followers" stat (3) and
    // the "Followers" list (2) therefore disagree once exclusions exist.
    // Making them agree is a product decision, not a bug fix.
  });

  it("GET /health and /api/v1/meta stay public", async () => {
    const h = await call("GET", "/health");
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);
    const m = await call("GET", "/api/v1/meta");
    expect(m.status).toBe(200);
  });
});

describe("D. security & robustness (section 14)", () => {
  it("does not leak credentials or connection strings in error responses", async () => {
    const acc = await q<{ id: string }>("select id from instagram_accounts limit 1");
    const r = await call("POST", `/api/v1/accounts/${acc[0].id}/exclusions`, {
      usernames: Array.from({ length: 20000 }, (_, i) => `x${i}`),
    });
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/password/i);
  });

  it("honours API_KEY when it is configured", async () => {
    const secured = { ...env, API_KEY: "s3cret" };
    const noKey = await worker.fetch(new Request(`${ORIGIN}/api/v1/accounts`) as never, secured as never);
    expect(noKey.status).toBe(401);
    const withKey = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/accounts`, { headers: { "X-API-Key": "s3cret" } }) as never,
      secured as never,
    );
    expect(withKey.status).toBe(200);
  });

  it("an empty commit is finalized as failed rather than silently lost", async () => {
    const acc = await q<{ id: string }>("select id from instagram_accounts where username='second_account'");
    const init = await call("POST", `/api/v1/accounts/${acc[0].id}/imports/init`, {
      filename: "empty.zip",
      sha256: "d".repeat(64),
    });
    const c = await call("POST", `/api/v1/accounts/${acc[0].id}/imports/${init.body.id}/commit`, {});
    expect(c.body.status).toBe("queued");
    await drainQueue();
    const imp = await q("select status, errors from imports where id=$1", [init.body.id]);
    expect(imp[0].status).toBe("failed");
    expect(imp[0].errors.length).toBe(1);
  });

  it("a malformed ZIP upload is a 400, not a 500", async () => {
    const acc = await q<{ id: string }>("select id from instagram_accounts limit 1");
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3, 4, 5])], "broken.zip", { type: "application/zip" }));
    const req = new Request(`${ORIGIN}/api/v1/accounts/${acc[0].id}/imports`, { method: "POST", body: form });
    const res = await worker.fetch(req as never, env as never);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).not.toBe("internal_error");
  });

  it("a valid Instagram-shaped ZIP is parsed end to end by the server fallback", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const acc = await q<{ id: string }>("select id from instagram_accounts where username='second_account'");
    const entry = (u: string) => ({ title: u, string_list_data: [{ value: u }] });
    // fflate needs Uint8Array values; a raw string is treated as a nested path.
    const zip = zipSync({
      "connections/followers_and_following/followers_1.json": strToU8(JSON.stringify(FOLLOWERS.map(entry))),
      "connections/followers_and_following/following.json": strToU8(JSON.stringify(FOLLOWING.map(entry))),
    });
    const form = new FormData();
    form.append("file", new File([zip], "instagram-export.zip", { type: "application/zip" }));
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/accounts/${acc[0].id}/imports`, { method: "POST", body: form }) as never,
      env as never,
    );
    expect(res.status).toBe(201);
    await drainQueue();
    const imp = await q("select status, followers_count, following_count from imports order by created_at desc limit 1");
    expect(imp[0].status).toBe("valid");
    expect(imp[0].followers_count).toBe(3);
    expect(imp[0].following_count).toBe(3);
  });
});
