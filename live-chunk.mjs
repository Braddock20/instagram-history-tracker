/** LIVE test of the remaining untested routes — the exact browser flow. */
const BASE = "https://instagram-history-tracker.talesapi.workers.dev";
let pass = 0, fail = 0; const failed = [];
async function hit(m, p, { body } = {}) {
  const h = {}; let pl;
  if (body instanceof FormData) pl = body;
  else if (body !== undefined) { h["content-type"] = "application/json"; pl = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method: m, headers: h, body: pl, signal: AbortSignal.timeout(30_000) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
const check = (n, ok, d = "") => { ok ? pass++ : fail++; if (!ok) failed.push(`${n} — ${d}`); console.log(`${ok ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

const stamp = Date.now().toString(36);
const acc = await hit("POST", "/api/v1/accounts", { body: { username: `chunk_test_${stamp}`, display_name: "Chunk Test" } });
const id = acc.json.id;
console.log(`\n=== LIVE CHUNK/COMMIT FLOW  (the dashboard's own path)  ${id} ===\n`);

console.log("--- 1. init");
const init = await hit("POST", `/api/v1/accounts/${id}/imports/init`, {
  body: { filename: "browser.zip", sha256: "c".repeat(64), observed_at: new Date().toISOString() },
});
check("init 201 + import id", init.status === 201 && !!init.json?.id, JSON.stringify(init.json).slice(0, 120));
const importId = init.json.id;
check("init status is staging", init.json?.status === "staging", init.json?.status);

console.log("\n--- 2. chunk upload (exactly the spec payload)");
const chunk = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/chunk`, {
  body: { followers: ["alice_test", "bob_test", "charlie_test"], following: ["alice_test", "bob_test", "david_test"] },
});
check("chunk 200", chunk.status === 200, `HTTP ${chunk.status} ${JSON.stringify(chunk.json)}`);
check("staged 3 followers", chunk.json?.staged_followers === 3, String(chunk.json?.staged_followers));
check("staged 3 following", chunk.json?.staged_following === 3, String(chunk.json?.staged_following));

console.log("\n--- 3. duplicate chunk (browser retry / flaky network)");
const again = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/chunk`, {
  body: { followers: ["alice_test", "bob_test", "charlie_test"], following: ["alice_test", "bob_test", "david_test"] },
});
check("re-sent chunk is idempotent 200", again.status === 200, `HTTP ${again.status}`);

console.log("\n--- 4. normalization + junk rejection via the live chunk route");
const norm = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/chunk`, {
  body: { followers: ["@Mixed_Case", "not valid!", "  ", "__deleted__placeholder"], following: [] },
});
check("junk chunk accepted 200", norm.status === 200, `HTTP ${norm.status}`);
check("only @Mixed_Case survived -> 1", norm.json?.staged_followers === 1, `got ${norm.json?.staged_followers}`);

console.log("\n--- 5. guards");
const badImport = await hit("POST", `/api/v1/accounts/${id}/imports/not-a-uuid/chunk`, { body: { followers: ["x"] } });
check("non-uuid importId -> 400", badImport.status === 400, `HTTP ${badImport.status} ${badImport.json?.error}`);
const badJson = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/chunk`, { body: "{{{", headers: { "content-type": "application/json" } });
check("malformed chunk JSON -> 400", badJson.status === 400, `HTTP ${badJson.status} ${badJson.json?.error}`);
const over = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/chunk`, {
  body: { followers: Array.from({ length: 6000 }, (_, i) => `z${i}`), following: Array.from({ length: 6000 }, (_, i) => `z${i}`) },
});
check("oversized chunk -> 413", over.status === 413, `HTTP ${over.status} ${over.json?.error}`);

console.log("\n--- 6. commit -> queue -> finalize");
const commit = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/commit`, { body: {} });
check("commit -> queued", commit.status === 200 && commit.json?.status === "queued", JSON.stringify(commit.json));
let final = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = await hit("GET", `/api/v1/accounts/${id}/imports/${importId}`);
  if (["valid", "valid_with_warnings", "failed", "invalid"].includes(s.json?.status)) { final = s.json; break; }
}
check("queue finalized the import", !!final, final ? final.status : "timed out");
if (final) {
  check("status valid", final.status === "valid" || final.status === "valid_with_warnings", final.status);
  check("followers = 4 (3 + mixed_case)", final.followers_count === 4, String(final.followers_count));
  check("following = 3", final.following_count === 3, String(final.following_count));
  check("no errors", (final.errors || []).length === 0, JSON.stringify(final.errors));
  check("snapshot_id assigned", !!final.snapshot_id, String(final.snapshot_id));
}

console.log("\n--- 7. commit is idempotent / not-repeatable");
const commit2 = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/commit`, { body: {} });
check("2nd commit on a valid import -> 409 import_not_ready", commit2.status === 409, `HTTP ${commit2.status} ${commit2.json?.error}`);
const chunkAfter = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/chunk`, { body: { followers: ["nope"] } });
check("chunk after finalize -> 409", chunkAfter.status === 409, `HTTP ${chunkAfter.status} ${chunkAfter.json?.error}`);

console.log("\n--- 8. retry route on a valid import -> 409");
const retry = await hit("POST", `/api/v1/accounts/${id}/imports/${importId}/retry`, { body: {} });
check("retry a valid import -> 409", retry.status === 409, `HTTP ${retry.status} ${retry.json?.error}`);

console.log("\n--- 9. /analytics/relationships (untested route)");
const ar = await hit("GET", `/api/v1/accounts/${id}/analytics/relationships`);
check("analytics/relationships 200", ar.status === 200, `HTTP ${ar.status} ${ar.json?.error || ""}`);
check("never_followed_back contains david_test", (ar.json?.never_followed_back || []).includes("david_test"), JSON.stringify(ar.json?.never_followed_back));
check("counts present", ar.json?.counts && typeof ar.json.counts.never_followed_back === "number", JSON.stringify(ar.json?.counts));

console.log("\n--- 10. exclusions import + single delete (untested routes)");
const fd = new FormData();
fd.append("file", new File([JSON.stringify({ usernames: ["imported_one", "imported_two"] })], "ex.json", { type: "application/json" }));
const exImp = await hit("POST", `/api/v1/accounts/${id}/exclusions/import`, { body: fd });
check("exclusions/import 200", exImp.status === 200 && exImp.json?.imported === 2, JSON.stringify(exImp.json));
const fdTxt = new FormData();
fdTxt.append("file", new File(["plain_one, plain_two\nplain_three"], "ex.txt", { type: "text/plain" }));
const exTxt = await hit("POST", `/api/v1/accounts/${id}/exclusions/import`, { body: fdTxt });
check("exclusions/import .txt 200", exTxt.status === 200 && exTxt.json?.imported === 3, JSON.stringify(exTxt.json));
const exDel = await hit("DELETE", `/api/v1/accounts/${id}/exclusions/plain_one`);
check("DELETE single exclusion 200", exDel.status === 200, `HTTP ${exDel.status}`);
const exDelMissing = await hit("DELETE", `/api/v1/accounts/${id}/exclusions/nobody_here`);
check("DELETE missing exclusion -> 404", exDelMissing.status === 404, `HTTP ${exDelMissing.status}`);
const exList = await hit("GET", `/api/v1/accounts/${id}/exclusions`);
const names = (exList.json?.exclusions || []).map((e) => e.username).sort();
check("plain_one really gone", !names.includes("plain_one"), names.join(","));
check("imported_* present", names.includes("imported_one") && names.includes("imported_two"), names.join(","));
const exBad = await hit("POST", `/api/v1/accounts/${id}/exclusions`, { body: { usernames: [] } });
check("empty exclusion list -> 400", exBad.status === 400, `HTTP ${exBad.status} ${exBad.json?.error}`);

console.log("\n--- 11. people search + history");
const ppl = await hit("GET", `/api/v1/accounts/${id}/people?q=ali`);
check("people search works", ppl.status === 200 && ppl.json?.people?.length >= 1, JSON.stringify(ppl.json).slice(0, 120));
const hist = await hit("GET", `/api/v1/accounts/${id}/people/alice_test/history`);
check("person history 200", hist.status === 200, `HTTP ${hist.status}`);
check("alice is a mutual (follows_you && you_follow)", (hist.json?.history || []).some((h) => h.follows_you && h.you_follow), JSON.stringify(hist.json?.history));
const histMissing = await hit("GET", `/api/v1/accounts/${id}/people/nobody/history`);
check("unknown person -> 404", histMissing.status === 404, `HTTP ${histMissing.status}`);

console.log("\n--- cleanup");
const del = await hit("DELETE", `/api/v1/accounts/${id}`);
check("account deleted", del.status === 200, `HTTP ${del.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed, ${pass + fail} total ===\n`);
if (failed.length) { console.log("FAILURES:"); for (const f of failed) console.log("  ❌ " + f); }
