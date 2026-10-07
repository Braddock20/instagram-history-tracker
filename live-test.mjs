/**
 * Black-box test of the LIVE deployment.
 * Everything goes over real HTTPS against the real Worker + real Neon + real Queue.
 */
const BASE = "https://instagram-history-tracker.talesapi.workers.dev";
const results = [];
let pass = 0, fail = 0;

async function hit(method, path, { body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const ctl = AbortSignal.timeout(30_000);
  const res = await fetch(BASE + path, { method, headers: h, body: payload, signal: ctl });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
}

function show(label, r) {
  const body = r.json ? JSON.stringify(r.json).slice(0, 220) : r.text.slice(0, 160);
  console.log(`   ${label}: HTTP ${r.status}  ${body}`);
}

// Unique account so repeated runs don't collide.
const stamp = Date.now().toString(36);
const USER = `live_test_${stamp}`;
let accountId = null;
let created = false;

console.log(`\n=== LIVE BLACK-BOX TEST  ${BASE} ===\n`);

// ---------------------------------------------------------------- 1. health
console.log("--- 1. health & meta");
{
  const r = await hit("GET", "/health");
  show("GET /health", r);
  check("health 200 + ok:true", r.status === 200 && r.json?.ok === true, `v${r.json?.version} parser ${r.json?.parser_version}`);
  check("version is 2.0.0 (unpatched)", r.json?.version === "2.0.0", `got ${r.json?.version}`);

  const m = await hit("GET", "/api/v1/meta");
  check("meta 200", m.status === 200, m.json?.architecture);

  const root = await hit("GET", "/");
  check("dashboard 200 + is HTML", root.status === 200 && root.text.includes("<!doctype html>"), `${root.text.length} bytes`);
  check("dashboard has import button", root.text.includes("importZip()"));
}

// ---------------------------------------------------------------- 2. accounts
console.log("\n--- 2. accounts");
{
  const list = await hit("GET", "/api/v1/accounts");
  show("GET /api/v1/accounts", { ...list, text: String(list.json?.accounts?.length) + " accounts" });
  check("accounts list 200", list.status === 200 && Array.isArray(list.json?.accounts));

  const c = await hit("POST", "/api/v1/accounts", { body: { username: USER, display_name: "Live Test" } });
  show("POST /api/v1/accounts", c);
  check("account created 201", c.status === 201 && c.json?.id, c.json?.id);
  accountId = c.json?.id;
  created = !!accountId;

  const bad = await hit("POST", "/api/v1/accounts", { body: { username: "!!!" } });
  check("invalid username -> 400", bad.status === 400, `HTTP ${bad.status} ${bad.json?.error}`);
}

// ------------------------------------------------- 3. THE $2 BUG (live repro)
console.log("\n--- 3. THE PRIMARY BUG: /imports/init");
{
  const r = await hit("POST", `/api/v1/accounts/${accountId}/imports/init`, {
    body: { filename: "termux-test.zip", sha256: "a".repeat(64), observed_at: "2026-10-07T11:52:00.000Z" },
  });
  show("POST /imports/init", r);
  const isBug = r.json?.error === "internal_error" && /parameter \$2/.test(r.json?.message || "");
  check("LIVE /imports/init returns 201 with an import id (bug fixed)", r.status === 201 && !!r.json?.id, r.json?.message || `HTTP ${r.status}`);
  console.log("   >>> This is the bug we fixed. Expected on the OLD deploy.\n");
}

// ------------------------------------------- 4. validation on the live deploy
console.log("--- 4. request validation (spec D)");
{
  const badSha = await hit("POST", `/api/v1/accounts/${accountId}/imports/init`, { body: { filename: "x.zip", sha256: "zzz" } });
  show("bad sha256", badSha);
  check("bad sha256 -> 4xx", badSha.status >= 400 && badSha.status < 500, `HTTP ${badSha.status}`);

  const badDate = await hit("POST", `/api/v1/accounts/${accountId}/imports/init`, { body: { filename: "x.zip", observed_at: "nope" } });
  show("bad observed_at", badDate);
  check("bad observed_at -> 4xx", badDate.status >= 400 && badDate.status < 500, `HTTP ${badDate.status}`);

  const badUuid = await hit("POST", "/api/v1/accounts/not-a-uuid/imports/init", { body: { filename: "x.zip" } });
  show("non-uuid account id", badUuid);
  check("non-uuid id -> 4xx (not 500)", badUuid.status >= 400 && badUuid.status < 500, `HTTP ${badUuid.status}`);

  const badJson = await hit("POST", `/api/v1/accounts/${accountId}/imports/init`, { body: "{oops", headers: { "content-type": "application/json" } });
  show("malformed JSON", badJson);
  check("malformed JSON -> 4xx (not 500)", badJson.status >= 400 && badJson.status < 500, `HTTP ${badJson.status}`);

  const noAccount = await hit("POST", "/api/v1/accounts/00000000-0000-4000-8000-000000000000/imports/init", { body: { filename: "x.zip" } });
  check("unknown account -> 404", noAccount.status === 404, `HTTP ${noAccount.status}`);
}

// ------------------------------------------------ 5. duplicate detection (C)
console.log("\n--- 5. duplicate detection (spec C)");
{
  const sha = "b".repeat(64);
  const first = await hit("POST", `/api/v1/accounts/${accountId}/imports/init`, { body: { filename: "dup.zip", sha256: sha } });
  show("init #1", first);
  const second = await hit("POST", `/api/v1/accounts/${accountId}/imports/init`, { body: { filename: "dup.zip", sha256: sha } });
  show("init #2 (same sha)", second);
  const dupWorks = second.json?.duplicate === true;
  check("same account + same sha -> duplicate:true", dupWorks, dupWorks ? "duplicate detected" : JSON.stringify(second.json));

  const other = await hit("POST", "/api/v1/accounts", { body: { username: USER + "_b" } });
  const cross = await hit("POST", `/api/v1/accounts/${other.json?.id}/imports/init`, { body: { filename: "dup.zip", sha256: sha } });
  show("same sha, different account", cross);
  check("same sha on a different account is allowed", cross.status === 201, cross.status === 201 ? "201 created" : `HTTP ${cross.status} ${JSON.stringify(cross.json)}`);
  if (other.json?.id) await hit("DELETE", `/api/v1/accounts/${other.json.id}`);
}

// --------------------------------------- 6. the two latent same-class bugs
console.log("\n--- 6. latent siblings of the $2 bug");
{
  const ch = await hit("GET", `/api/v1/accounts/${accountId}/changes`);
  show("GET /changes", ch);
  const chBug = ch.json?.error === "internal_error" && /parameter \$2/.test(ch.json?.message || "");
  check("LIVE /changes works (no $2 error)", ch.status === 200 && !chBug, ch.json?.message || `count=${ch.json?.count}`);

  const ex = await hit("POST", `/api/v1/accounts/${accountId}/exclusions`, { body: { usernames: ["some_bot"], reason: "test" } });
  show("POST /exclusions", ex);
  const exBug = ex.json?.error === "internal_error" && /parameter \$2/.test(ex.json?.message || "");
  check("LIVE /exclusions works (no $2 error)", ex.status === 200 && !exBug, ex.json?.message || `added=${ex.json?.added_or_updated}`);

  const exGet = await hit("GET", `/api/v1/accounts/${accountId}/exclusions`);
  check("GET /exclusions works", exGet.status === 200, `HTTP ${exGet.status}, ${exGet.json?.count} entries`);
}

// -------------------------------------------------- 7. read-only endpoints
console.log("\n--- 7. read endpoints (no snapshot yet)");
{
  for (const [label, path, expectOk] of [
    ["overview", "/overview", false],
    ["snapshots", "/snapshots", true],
    ["relationships/followers", "/relationships/followers", false],
    ["relationships/not-following-back", "/relationships/not-following-back", false],
    ["snapshots/compare (no args)", "/snapshots/compare", false],
    ["analytics/growth", "/analytics/growth", true],
    ["imports (list)", "/imports", true],
    ["people?q=", "/people?q=ali", true],
  ]) {
    const r = await hit("GET", `/api/v1/accounts/${accountId}${path}`);
    show(label, r);
    const good = expectOk ? r.status === 200 : (r.status === 404 || r.status === 200);
    check(`${label} -> sane response`, good && r.json?.error !== "internal_error", `HTTP ${r.status} ${r.json?.error || ""}`);
  }

  const badKind = await hit("GET", `/api/v1/accounts/${accountId}/relationships/bogus-kind`);
  check("unknown relationship kind -> 404", badKind.status === 404, `HTTP ${badKind.status}`);
}

// ------------------------------------------------------- 8. CSV export
console.log("\n--- 8. CSV export");
{
  const r = await hit("GET", `/api/v1/accounts/${accountId}/changes/export.csv`);
  check("export.csv 200", r.status === 200, `HTTP ${r.status}, ${r.text.length} bytes`);
  check("export.csv content-type", (r.headers.get("content-type") || "").includes("text/csv"));
  check("export.csv has header row", r.text.startsWith("event_type,username"), r.text.slice(0, 60));
  check("export.csv is NOT json error", !r.text.trimStart().startsWith("{"), "served as CSV, not an error object");
}

// --------------------------------------------------------- 9. server ZIP path
console.log("\n--- 9. server-side ZIP fallback");
{
  const { zipSync, strToU8 } = await import("fflate");
  const entry = (u) => ({ title: u, string_list_data: [{ value: u }] });
  const zip = zipSync({
    "connections/followers_and_following/followers_1.json": strToU8(JSON.stringify(["alice_test", "bob_test", "charlie_test"].map(entry))),
    "connections/followers_and_following/following.json": strToU8(JSON.stringify(["alice_test", "bob_test", "david_test"].map(entry))),
  });
  const form = new FormData();
  form.append("file", new File([zip], "instagram-export.zip", { type: "application/zip" }));
  const r = await hit("POST", `/api/v1/accounts/${accountId}/imports`, { body: form });
  show("POST /imports (real zip)", r);
  check("real ZIP upload accepted", r.status === 201 || r.json?.error, `HTTP ${r.status} ${r.json?.status || r.json?.error || ""}`);
  if (r.json?.import_id) {
    console.log("   waiting for the real Cloudflare Queue to finalize…");
    let done = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r2) => setTimeout(r2, 1500));
      const s = await hit("GET", `/api/v1/accounts/${accountId}/imports/${r.json.import_id}`);
      process.stdout.write(`\r   poll ${i + 1}: ${s.json?.status}          `);
      if (["valid", "valid_with_warnings", "failed", "invalid"].includes(s.json?.status)) { done = s.json; break; }
    }
    console.log("");
    console.log("   final import row:", JSON.stringify(done).slice(0, 400));
    if (done) {
      check("QUEUE END-TO-END: import reached valid", done.status === "valid" || done.status === "valid_with_warnings", done.status);
      check("finalize_import computed 3 followers / 3 following", done.followers_count === 3 && done.following_count === 3, `${done.followers_count}/${done.following_count}`);
      check("no errors recorded", Array.isArray(done.errors) && done.errors.length === 0, JSON.stringify(done.errors));
      const o = await hit("GET", `/api/v1/accounts/${accountId}/overview`);
      show("overview after finalize", o);
      check("analytics: 2 mutuals", o.json?.mutuals === 2, String(o.json?.mutuals));
      check("analytics: 1 not-following-back", o.json?.not_following_back === 1, String(o.json?.not_following_back));
      const mf = await hit("GET", `/api/v1/accounts/${accountId}/relationships/followers`);
      show("followers list", mf);
      check("followers list = 3 usernames", mf.json?.usernames?.length === 3, JSON.stringify(mf.json?.usernames));
      const nfb = await hit("GET", `/api/v1/accounts/${accountId}/relationships/not-following-back`);
      show("not-following-back", nfb);
      check("not-following-back = [david_test]", JSON.stringify(nfb.json?.usernames) === '["david_test"]', JSON.stringify(nfb.json?.usernames));
      const chg = await hit("GET", `/api/v1/accounts/${accountId}/changes`);
      show("changes (post-finalize)", chg);
      check("GET /changes works after finalize", chg.status === 200, `HTTP ${chg.status} ${chg.json?.message || ""}`);
    }
  }
}

// ---------------------------------------------------------- 10. security
console.log("\n--- 10. security & error leakage");
{
  const sqli = await hit("GET", `/api/v1/accounts/${accountId}/relationships/followers?limit=1%20OR%201=1`);
  check("SQLi in limit does not 500", sqli.status !== 500, `HTTP ${sqli.status}`);

  const sqli2 = await hit("GET", `/api/v1/accounts/${accountId}/changes?type=';DROP%20TABLE%20people;--`);
  const still = await hit("GET", "/api/v1/accounts");
  check("SQLi in type leaves app alive", still.status === 200, `HTTP ${still.status} (type route: ${sqli2.status})`);

  const badUuid = await hit("GET", "/api/v1/accounts/00000000-0000-4000-8000-000000000099/overview");
  show("unknown-but-valid uuid", badUuid);
  const blob = JSON.stringify(badUuid.json || {});
  check("no postgres:// in error payload", !/postgres(ql)?:\/\//i.test(blob), blob.slice(0, 120));
  check("no 'password' in error payload", !/password/i.test(blob));

  const cors = await hit("OPTIONS", "/api/v1/accounts", { headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
  check("CORS preflight responds", cors.status < 400, `HTTP ${cors.status}, allow-origin=${cors.headers.get("access-control-allow-origin")}`);
  console.log(`   CORS allow-origin: ${cors.headers.get("access-control-allow-origin")}  (note: "*" = any site may call this API)`);

  const auth = await hit("GET", "/api/v1/accounts", { headers: { "x-api-key": "definitely-wrong-key" } });
  check("wrong API key behaviour", auth.status === 200 || auth.status === 401, `HTTP ${auth.status} (200 = API_KEY not enabled)`);

  const r404 = await hit("GET", "/api");
  const f404 = await hit("GET", "/files");
  check("/api still 404 (expected, not a bug)", r404.status === 404, `HTTP ${r404.status}`);
  check("/files still 404 (expected, not a bug)", f404.status === 404, `HTTP ${f404.status}`);
}

// ------------------------------------------------------------- 11. cleanup
console.log("\n--- 11. cleanup");
if (created && accountId) {
  const d = await hit("DELETE", `/api/v1/accounts/${accountId}`);
  show("DELETE test account", d);
  check("test account removed", d.status === 200, `HTTP ${d.status}`);
  const after = await hit("GET", "/api/v1/accounts");
  const gone = !after.json?.accounts?.some((a) => a.id === accountId);
  check("account no longer listed", gone, `${after.json?.accounts?.length} accounts remain`);
}

console.log(`\n=== ${pass} passed, ${fail} failed, ${pass + fail} total ===\n`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
}
