/**
 * LIVE test of the historical path — the actual reason this app exists.
 * Two snapshots with different people must produce the 4 inferred event types.
 */
const BASE = "https://instagram-history-tracker.talesapi.workers.dev";
let pass = 0, fail = 0;
const failed = [];

async function hit(method, path, { body } = {}) {
  const h = {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  if (!ok) failed.push(`${name} — ${detail}`);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
}

const { zipSync, strToU8 } = await import("fflate");
const entry = (u) => ({ title: u, string_list_data: [{ value: u }] });

function makeZip(followers, following, name) {
  const zip = zipSync({
    "connections/followers_and_following/followers_1.json": strToU8(JSON.stringify(followers.map(entry))),
    "connections/followers_and_following/following.json": strToU8(JSON.stringify(following.map(entry))),
  });
  const form = new FormData();
  form.append("file", new File([zip], name, { type: "application/zip" }));
  return form;
}

async function importAndWait(accountId, followers, following, name) {
  const up = await hit("POST", `/api/v1/accounts/${accountId}/imports`, { body: makeZip(followers, following, name) });
  if (up.status !== 201) return { ok: false, up };
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await hit("GET", `/api/v1/accounts/${accountId}/imports/${up.json.import_id}`);
    if (["valid", "valid_with_warnings", "failed", "invalid"].includes(s.json?.status)) return { ok: true, status: s.json.status, row: s.json };
  }
  return { ok: false, up, reason: "timeout" };
}

const stamp = Date.now().toString(36);
const acc = await hit("POST", "/api/v1/accounts", { body: { username: `hist_test_${stamp}`, display_name: "History Test" } });
const accountId = acc.json.id;
console.log(`\n=== LIVE HISTORY TEST  (account ${accountId}) ===\n`);

console.log("--- snapshot #1");
const s1 = await importAndWait(accountId, ["alice", "bob", "charlie"], ["alice", "bob", "david"], "export-1.zip");
check("snapshot 1 finalized valid", s1.ok && s1.status === "valid", JSON.stringify(s1.row?.errors || s1.reason || s1.status));

console.log("\n--- snapshot #2 (erin new follower, charlie gone; frank new following, david gone)");
await new Promise((r) => setTimeout(r, 1500)); // ensure observed_at increases
const s2 = await importAndWait(accountId, ["alice", "bob", "erin"], ["alice", "bob", "frank"], "export-2.zip");
check("snapshot 2 finalized valid", s2.ok && s2.status === "valid", JSON.stringify(s2.row?.errors || s2.reason || s2.status));

console.log("\n--- inferred events");
const ch = await hit("GET", `/api/v1/accounts/${accountId}/changes`);
check("GET /changes 200", ch.status === 200, `HTTP ${ch.status}`);
const events = ch.json?.changes || [];
const kinds = events.map((e) => `${e.event_type}:${e.username}`);
console.log("   events:", kinds.join(", ") || "(none)");
check("exactly 4 events inferred", events.length === 4, `got ${events.length}`);
check("followed_you = erin", kinds.includes("followed_you:erin"), kinds.join(","));
check("unfollowed_you = charlie", kinds.includes("unfollowed_you:charlie"), kinds.join(","));
check("you_followed = frank", kinds.includes("you_followed:frank"), kinds.join(","));
check("you_unfollowed = david", kinds.includes("you_unfollowed:david"), kinds.join(","));
check("events carry occurred_after AND occurred_before", events.every((e) => e.occurred_after && e.occurred_before),
  events.map((e) => `${e.occurred_after ? "A" : "-"}${e.occurred_before ? "B" : "-"}`).join(" "));
check("no exact-timestamp lie (occurred_after != occurred_before)",
  events.every((e) => e.occurred_after !== e.occurred_before));

console.log("\n--- type filter");
for (const t of ["followed_you", "unfollowed_you", "you_followed", "you_unfollowed"]) {
  const f = await hit("GET", `/api/v1/accounts/${accountId}/changes?type=${t}`);
  check(`?type=${t} filters to 1`, f.status === 200 && f.json?.count === 1, `count=${f.json?.count}`);
}
const bogus = await hit("GET", `/api/v1/accounts/${accountId}/changes?type=nonsense`);
check("?type=nonsense -> 400 invalid_event_type", bogus.status === 400 && bogus.json?.error === "invalid_event_type", `HTTP ${bogus.status} ${bogus.json?.error}`);

console.log("\n--- snapshots & overview");
const sn = await hit("GET", `/api/v1/accounts/${accountId}/snapshots`);
check("2 snapshots exist", sn.json?.snapshots?.length === 2, `got ${sn.json?.snapshots?.length}`);
const snaps = sn.json.snapshots || [];
check("newest snapshot first (desc)", snaps.length === 2 && new Date(snaps[0].observed_at) > new Date(snaps[1].observed_at));

const ov = await hit("GET", `/api/v1/accounts/${accountId}/overview`);
check("overview reflects CURRENT snapshot (erin/erin/frank)", ov.json?.followers === 3 && ov.json?.following === 3, `${ov.json?.followers}/${ov.json?.following}`);
check("mutuals = 2 (alice, bob)", ov.json?.mutuals === 2, String(ov.json?.mutuals));
check("not-following-back = 1 (frank)", ov.json?.not_following_back === 1, String(ov.json?.not_following_back));
check("change_since_previous computed", ov.json?.change_since_previous !== null, JSON.stringify(ov.json?.change_since_previous));
check("followers delta 0 (3->3)", ov.json?.change_since_previous?.followers === 0, String(ov.json?.change_since_previous?.followers));

const growth = await hit("GET", `/api/v1/accounts/${accountId}/analytics/growth`);
check("growth has 2 points", growth.json?.points?.length === 2, `got ${growth.json?.points?.length}`);

const churn = await hit("GET", `/api/v1/accounts/${accountId}/analytics/churn`);
check("churn returns points", churn.status === 200, JSON.stringify(churn.json).slice(0, 120));

console.log("\n--- relationship classification");
for (const [kind, expect] of [
  ["followers", ["alice", "bob", "erin"]],
  ["following", ["alice", "bob", "frank"]],
  ["mutuals", ["alice", "bob"]],
  ["not-following-back", ["frank"]],
  ["never-followed-back", ["frank"]],
  ["used-to-follow", []],
]) {
  const r = await hit("GET", `/api/v1/accounts/${accountId}/relationships/${kind}`);
  const got = r.json?.usernames;
  check(`${kind} = ${JSON.stringify(expect)}`, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got));
}

console.log("\n--- snapshot compare");
const cmp = await hit("GET", `/api/v1/accounts/${accountId}/snapshots/compare?from=${snaps[1].id}&to=${snaps[0].id}`);
check("compare 200", cmp.status === 200, `HTTP ${cmp.status}`);
check("followers gained erin", JSON.stringify(cmp.json?.followers?.gained) === '["erin"]', JSON.stringify(cmp.json?.followers?.gained));
check("followers lost charlie", JSON.stringify(cmp.json?.followers?.lost) === '["charlie"]', JSON.stringify(cmp.json?.followers?.lost));
check("following gained frank", JSON.stringify(cmp.json?.following?.gained) === '["frank"]', JSON.stringify(cmp.json?.following?.gained));
check("following lost david", JSON.stringify(cmp.json?.following?.lost) === '["david"]', JSON.stringify(cmp.json?.following?.lost));

console.log("\n--- person history");
const hist = await hit("GET", `/api/v1/accounts/${accountId}/people/charlie/history`);
check("person history 200", hist.status === 200, `HTTP ${hist.status}`);
check("charlie: 2 snapshot rows", hist.json?.history?.length === 2, `got ${hist.json?.history?.length}`);
check("charlie has an unfollowed_you event", (hist.json?.events || []).some((e) => e.event_type === "unfollowed_you"), JSON.stringify(hist.json?.events));

console.log("\n--- CSV export now has rows");
const csv = await hit("GET", `/api/v1/accounts/${accountId}/changes/export.csv`);
check("csv has 4 data rows", csv.text.trim().split("\n").length === 5, `${csv.text.trim().split("\n").length} lines`);
check("csv mentions charlie", csv.text.includes("charlie"), "");

console.log("\n--- exclusions still work on top of real data");
const ex = await hit("POST", `/api/v1/accounts/${accountId}/exclusions`, { body: { usernames: ["frank"], reason: "spam" } });
check("exclude frank", ex.status === 200 && ex.json?.added_or_updated === 1, JSON.stringify(ex.json));
const nfb2 = await hit("GET", `/api/v1/accounts/${accountId}/relationships/not-following-back`);
check("frank removed from not-following-back", JSON.stringify(nfb2.json?.usernames) === "[]", JSON.stringify(nfb2.json?.usernames));
const exList = await hit("GET", `/api/v1/accounts/${accountId}/exclusions`);
check("exclusion listed", exList.json?.count === 1, JSON.stringify(exList.json));
const chAfter = await hit("GET", `/api/v1/accounts/${accountId}/changes`);
check("excluded user filtered from /changes", !(chAfter.json?.changes || []).some((e) => e.username === "frank"), "frank hidden");
const clear = await hit("POST", `/api/v1/accounts/${accountId}/exclusions/clear`, { body: {} });
check("clear exclusions", clear.status === 200 && clear.json?.deleted === 1, JSON.stringify(clear.json));
const chRestored = await hit("GET", `/api/v1/accounts/${accountId}/changes`);
check("frank back in /changes after clear", (chRestored.json?.changes || []).some((e) => e.username === "frank"), "restored");

console.log("\n--- duplicate ZIP rejection end-to-end");
const dupUp = await hit("POST", `/api/v1/accounts/${accountId}/imports`, { body: makeZip(["alice", "bob", "erin"], ["alice", "bob", "frank"], "export-2.zip") });
check("re-uploading the identical ZIP -> duplicate:true", dupUp.json?.duplicate === true, `HTTP ${dupUp.status} ${JSON.stringify(dupUp.json).slice(0, 120)}`);
const snapsAfter = await hit("GET", `/api/v1/accounts/${accountId}/snapshots`);
check("duplicate did NOT create a 3rd snapshot", snapsAfter.json?.snapshots?.length === 2, `got ${snapsAfter.json?.snapshots?.length}`);

console.log("\n--- cleanup");
const del = await hit("DELETE", `/api/v1/accounts/${accountId}`);
check("test account deleted (cascades all children)", del.status === 200, `HTTP ${del.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed, ${pass + fail} total ===\n`);
if (failed.length) { console.log("FAILURES:"); for (const f of failed) console.log("  ❌ " + f); }
