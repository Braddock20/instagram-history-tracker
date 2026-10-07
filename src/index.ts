import { Hono } from "hono";
import { cors } from "hono/cors";
import { db, asInt } from "./db";
import { parseInstagramZip } from "./parser";
import { normalizeUsername, uniqueNormalized } from "./normalize";
import { ratio, setDifference, setIntersection } from "./analytics";
import type { Env, ImportQueueMessage } from "./types";
import { UI } from "./ui";

const VERSION = "2.0.0";
const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "X-API-Key"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use("*", async (c, next) => {
  if (c.req.path === "/health" || c.req.path === "/api/v1/meta") return next();
  if (c.env.API_KEY && c.req.header("X-API-Key") !== c.env.API_KEY) return c.json({ error: "unauthorized" }, 401);
  return next();
});

function jsonError(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), { status, headers: { "content-type": "application/json" } });
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function finalize(env: Env, importId: string) {
  const sql = db(env);
  const result = await sql`select finalize_import(${importId}::uuid) as result`;
  return result[0]?.result;
}

async function enqueueOrFinalize(env: Env, importId: string) {
  if (env.IMPORT_QUEUE) {
    await env.IMPORT_QUEUE.send({ importId, kind: "finalize" } satisfies ImportQueueMessage);
    await db(env)`update imports set status='queued' where id=${importId}`;
    return { status: "queued", import_id: importId };
  }
  return await finalize(env, importId);
}

app.get("/", c => c.html(UI));
app.get("/health", async c => {
  try { await db(c.env)`select 1`; return c.json({ ok: true, version: VERSION, parser_version: VERSION }); }
  catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 503); }
});
app.get("/api/v1/meta", c => c.json({ name: c.env.APP_NAME || "Instagram History Tracker", version: VERSION, architecture: "ephemeral-zip-browser-parser-neon-postgres-cloudflare-queues" }));

app.post("/api/v1/accounts", async c => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const username = normalizeUsername(body.username);
  if (!username) return jsonError("invalid_username");
  const sql = db(c.env);
  const existing = await sql`select id,username,display_name,timezone,created_at from instagram_accounts where username=${username} limit 1`;
  if (existing.length) return c.json(existing[0]);
  const rows = await sql`insert into instagram_accounts(username,display_name,timezone) values(${username},${body.display_name ?? null},${body.timezone ?? "UTC"}) returning id,username,display_name,timezone,created_at`;
  return c.json(rows[0], 201);
});

app.get("/api/v1/accounts", async c => {
  const rows = await db(c.env)`select a.id,a.username,a.display_name,a.timezone,a.created_at,ls.observed_at last_snapshot_at,ls.followers_count,ls.following_count,ls.mutual_count,ls.not_following_back_count from instagram_accounts a left join latest_snapshots ls on ls.account_id=a.id order by a.created_at desc`;
  return c.json({ accounts: rows });
});

app.delete("/api/v1/accounts/:id", async c => {
  const id = c.req.param("id");
  const rows = await db(c.env)`delete from instagram_accounts where id=${id} returning id`;
  return rows.length ? c.json({ deleted: rows[0] }) : jsonError("account_not_found", 404);
});

app.post("/api/v1/accounts/:id/imports/init", async c => {
  const id = c.req.param("id");
  const sql = db(c.env);
  if (!(await sql`select id from instagram_accounts where id=${id}`).length) return jsonError("account_not_found", 404);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const filename = String(body.filename || "instagram-export.zip").slice(0, 255);
  const observedAt = body.observed_at ? new Date(body.observed_at) : new Date();
  if (Number.isNaN(observedAt.getTime())) return jsonError("invalid_observed_at");
  const sha = body.sha256 ? String(body.sha256).toLowerCase() : null;
  if (sha && !/^[a-f0-9]{64}$/.test(sha)) return jsonError("invalid_sha256");
  if (sha) {
    const dup = await sql`select id,status,snapshot_id,observed_at from imports where account_id=${id} and sha256=${sha} limit 1`;
    if (dup.length) return c.json({ duplicate: true, import: dup[0] });
  }
  const rows = await sql`insert into imports(account_id,original_filename,sha256,observed_at,status,parser_version) values(${id},${filename},${sha},${observedAt.toISOString()},'staging',${VERSION}) returning id,account_id,original_filename,observed_at,status,parser_version,created_at`;
  await sql`insert into audit_log(account_id,action,details) values(${id},'import_started',jsonb_build_object('import_id',${rows[0].id},'filename',${filename}))`;
  return c.json(rows[0], 201);
});

app.post("/api/v1/accounts/:id/imports", async c => {
  // Small-server fallback. The main UI uses browser parsing + staging chunks.
  const id = c.req.param("id"), max = asInt(c.env.MAX_USERNAME_COUNT, 500000);
  if (!(await db(c.env)`select id from instagram_accounts where id=${id}`).length) return jsonError("account_not_found", 404);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError("missing_file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 100_000_000) return jsonError("server_zip_too_large_use_browser_import", 413, { max_bytes: 100_000_000 });
  const digest = await sha256(bytes);
  const duplicate = await db(c.env)`select id,status,snapshot_id from imports where account_id=${id} and sha256=${digest} limit 1`;
  if (duplicate.length) return c.json({ duplicate: true, import: duplicate[0] });
  const parsed = parseInstagramZip(bytes, c.env);
  if (parsed.followers.size > max || parsed.following.size > max) return jsonError("username_limit_exceeded", 413);
  const init = await db(c.env)`insert into imports(account_id,original_filename,sha256,observed_at,status,parser_version,discovered_files,follower_files,following_files,warnings) values(${id},${file.name || "instagram-export.zip"},${digest},now(),'staging',${VERSION},${JSON.stringify(parsed.discoveredFiles)}::jsonb,${JSON.stringify(parsed.followerFiles)}::jsonb,${JSON.stringify(parsed.followingFiles)}::jsonb,${JSON.stringify(parsed.warnings)}::jsonb) returning id`;
  const importId = init[0].id as string;
  await stageArrays(c.env, importId, [...parsed.followers], [...parsed.following]);
  return c.json(await enqueueOrFinalize(c.env, importId), 201);
});

async function stageArrays(env: Env, importId: string, followers: string[], following: string[]) {
  const sql = db(env);
  if (followers.length) await sql`insert into import_usernames(import_id,username,relationship) select ${importId}::uuid,value,'follower' from jsonb_array_elements_text(${JSON.stringify(followers)}::jsonb) on conflict do nothing`;
  if (following.length) await sql`insert into import_usernames(import_id,username,relationship) select ${importId}::uuid,value,'following' from jsonb_array_elements_text(${JSON.stringify(following)}::jsonb) on conflict do nothing`;
}

app.post("/api/v1/accounts/:id/imports/:importId/chunk", async c => {
  const accountId = c.req.param("id"), importId = c.req.param("importId");
  const body = (await c.req.json().catch(() => null)) as any;
  if (!body) return jsonError("invalid_json");
  const followers = uniqueNormalized(Array.isArray(body.followers) ? body.followers : []);
  const following = uniqueNormalized(Array.isArray(body.following) ? body.following : []);
  const maxChunk = asInt(c.env.MAX_CHUNK_ITEMS, 5000);
  if (followers.length + following.length > maxChunk * 2) return jsonError("chunk_too_large", 413, { max_items: maxChunk * 2 });
  const sql = db(c.env);
  const rows = await sql`select id,status from imports where id=${importId} and account_id=${accountId}`;
  if (!rows.length) return jsonError("import_not_found", 404);
  if (!['staging','queued'].includes(rows[0].status)) return jsonError("import_not_staging", 409);
  await stageArrays(c.env, importId, followers, following);
  return c.json({ import_id: importId, staged_followers: followers.length, staged_following: following.length });
});

app.post("/api/v1/accounts/:id/imports/:importId/commit", async c => {
  const id = c.req.param("id"), importId = c.req.param("importId"), sql = db(c.env);
  const rows = await sql`select id,status from imports where id=${importId} and account_id=${id}`;
  if (!rows.length) return jsonError("import_not_found", 404);
  if (rows[0].status === 'queued') return c.json({ status: 'queued', import_id: importId });
  if (!['staging','processing'].includes(rows[0].status)) return jsonError("import_not_ready", 409, { status: rows[0].status });
  const result = await enqueueOrFinalize(c.env, importId);
  return c.json(result);
});

app.post("/api/v1/accounts/:id/imports/:importId/retry", async c => {
  const id = c.req.param("id"), importId = c.req.param("importId"), sql = db(c.env);
  const rows = await sql`select id,status from imports where id=${importId} and account_id=${id}`;
  if (!rows.length) return jsonError("import_not_found", 404);
  if (!['failed','staging'].includes(rows[0].status)) return jsonError("import_not_retryable", 409, { status: rows[0].status });
  return c.json(await enqueueOrFinalize(c.env, importId));
});

app.get("/api/v1/accounts/:id/imports/:importId", async c => {
  const rows = await db(c.env)`select * from imports where id=${c.req.param("importId")} and account_id=${c.req.param("id")}`;
  return rows.length ? c.json(rows[0]) : jsonError("import_not_found", 404);
});

app.get("/api/v1/accounts/:id/imports", async c => {
  const rows = await db(c.env)`select id,original_filename,sha256,observed_at,status,parser_version,snapshot_id,followers_count,following_count,warnings,errors,started_at,completed_at,created_at from imports where account_id=${c.req.param("id")} order by created_at desc limit 200`;
  return c.json({ imports: rows });
});

app.get("/api/v1/accounts/:id/snapshots", async c => {
  const rows = await db(c.env)`select id,import_id,observed_at,followers_count,following_count,mutual_count,not_following_back_count,excluded_count,created_at from snapshots where account_id=${c.req.param("id")} order by observed_at desc`;
  return c.json({ snapshots: rows });
});

async function latestSets(env: Env, accountId: string) {
  const sql = db(env);
  const snap = (await sql`select id,observed_at,followers_count,following_count,mutual_count,not_following_back_count,excluded_count from snapshots where account_id=${accountId} order by observed_at desc limit 1`)[0];
  if (!snap) return null;
  const [f, g, ex] = await Promise.all([
    sql`select p.username from snapshot_followers sf join people p on p.id=sf.person_id where sf.snapshot_id=${snap.id}`,
    sql`select p.username from snapshot_following sf join people p on p.id=sf.person_id where sf.snapshot_id=${snap.id}`,
    sql`select username from exclusion_entries where account_id=${accountId}`
  ]);
  return { snap, followers: new Set<string>(f.map((r: any) => String(r.username))), following: new Set<string>(g.map((r: any) => String(r.username))), exclusions: new Set<string>(ex.map((r: any) => String(r.username))) };
}

app.get("/api/v1/accounts/:id/overview", async c => {
  const data = await latestSets(c.env, c.req.param("id"));
  if (!data) return jsonError("no_snapshots", 404);
  const { snap, followers, following, exclusions } = data;
  const nfb = setDifference(following, followers).filter(x => !exclusions.has(x));
  const mutuals = setIntersection(following, followers).filter(x => !exclusions.has(x));
  const previous = await db(c.env)`select followers_count,following_count,observed_at from snapshots where account_id=${c.req.param("id")} and observed_at<${snap.observed_at} order by observed_at desc limit 1`;
  return c.json({ snapshot: snap, followers: followers.size, following: following.size, mutuals: mutuals.length, not_following_back: nfb.length, excluded_count: exclusions.size, follow_back_ratio: ratio(mutuals.length, following.size), change_since_previous: previous.length ? { followers: followers.size - Number(previous[0].followers_count), following: following.size - Number(previous[0].following_count), previous_observed_at: previous[0].observed_at } : null });
});

app.get("/api/v1/accounts/:id/relationships/:kind", async c => {
  const accountId = c.req.param("id"), kind = c.req.param("kind");
  if (!['followers','following','mutuals','not-following-back','never-followed-back','used-to-follow','excluded'].includes(kind)) return jsonError("unknown_relationship", 404);
  const page = Math.max(1, Number(c.req.query('page') || 1)), limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') || 100)));
  const data = await latestSets(c.env, accountId); if (!data) return jsonError("no_snapshots", 404);
  let values: string[];
  if (kind === 'followers') values = [...data.followers] as string[];
  else if (kind === 'following') values = [...data.following] as string[];
  else if (kind === 'mutuals') values = setIntersection(data.following, data.followers);
  else if (kind === 'not-following-back') values = setDifference(data.following, data.followers);
  else if (kind === 'never-followed-back' || kind === 'used-to-follow') { const prior = await db(c.env) `select distinct p.username from snapshot_followers sf join snapshots s on s.id=sf.snapshot_id join people p on p.id=sf.person_id where s.account_id=${accountId} and s.observed_at < ${data.snap.observed_at}`; const priorSet=new Set<string>(prior.map((r:any)=>String(r.username))); values=[...data.following].filter(x=>!data.followers.has(x) && (kind==='never-followed-back' ? !priorSet.has(x) : priorSet.has(x))); }
  else values = [...data.exclusions] as string[];
  values = values.filter(x => kind === 'excluded' || !data.exclusions.has(x)).sort();
  const start = (page - 1) * limit;
  return c.json({ kind, page, limit, total: values.length, usernames: values.slice(start, start + limit) });
});

app.get("/api/v1/accounts/:id/relationships/not-following-back", async c => {
  const data = await latestSets(c.env, c.req.param("id")); if (!data) return jsonError("no_snapshots", 404);
  const values = setDifference(data.following, data.followers).filter(x => !data.exclusions.has(x));
  return c.json({ count: values.length, usernames: values });
});


app.get("/api/v1/accounts/:id/analytics/relationships", async c => {
  const accountId = c.req.param("id"), sql = db(c.env);
  const latest = (await sql`select id,observed_at from snapshots where account_id=${accountId} order by observed_at desc limit 1`)[0];
  if (!latest) return jsonError("no_snapshots", 404);
  const currentFollowing = await sql`select p.id,p.username from snapshot_following sf join people p on p.id=sf.person_id where sf.snapshot_id=${latest.id} and not exists(select 1 from exclusion_entries e where e.account_id=${accountId} and e.username=p.username)`;
  const currentFollowers = await sql`select p.id,p.username from snapshot_followers sf join people p on p.id=sf.person_id where sf.snapshot_id=${latest.id} and not exists(select 1 from exclusion_entries e where e.account_id=${accountId} and e.username=p.username)`;
  const currentFollowerIds = new Set(currentFollowers.map((r:any)=>r.id));
  const currentFollowingIds = new Set(currentFollowing.map((r:any)=>r.id));
  const priorFollowers = await sql`select distinct p.id,p.username from snapshot_followers sf join snapshots s on s.id=sf.snapshot_id join people p on p.id=sf.person_id where s.account_id=${accountId} and s.observed_at<${latest.observed_at} and not exists(select 1 from exclusion_entries e where e.account_id=${accountId} and e.username=p.username)`;
  const priorFollowing = await sql`select distinct p.id,p.username from snapshot_following sf join snapshots s on s.id=sf.snapshot_id join people p on p.id=sf.person_id where s.account_id=${accountId} and s.observed_at<${latest.observed_at} and not exists(select 1 from exclusion_entries e where e.account_id=${accountId} and e.username=p.username)`;
  const priorFollowerIds = new Set(priorFollowers.map((r:any)=>r.id));
  const priorFollowingIds = new Set(priorFollowing.map((r:any)=>r.id));
  const neverFollowedBack = currentFollowing.filter((r:any)=>!priorFollowerIds.has(r.id) && !currentFollowerIds.has(r.id));
  const usedToFollow = currentFollowing.filter((r:any)=>priorFollowerIds.has(r.id) && !currentFollowerIds.has(r.id));
  const newFollowers = currentFollowers.filter((r:any)=>!priorFollowerIds.has(r.id));
  const newFollowing = currentFollowing.filter((r:any)=>!priorFollowingIds.has(r.id));
  return c.json({
    never_followed_back: neverFollowedBack.map((r:any)=>r.username),
    used_to_follow: usedToFollow.map((r:any)=>r.username),
    new_followers: newFollowers.map((r:any)=>r.username),
    new_following: newFollowing.map((r:any)=>r.username),
    counts: { never_followed_back: neverFollowedBack.length, used_to_follow: usedToFollow.length, new_followers: newFollowers.length, new_following: newFollowing.length }
  });
});

app.get("/api/v1/accounts/:id/snapshots/compare", async c => {
  const accountId=c.req.param("id"), from=c.req.query("from"), to=c.req.query("to"), sql=db(c.env);
  if (!from || !to) return jsonError("from_and_to_snapshot_ids_required");
  const rows=await sql`select id,observed_at from snapshots where account_id=${accountId} and id in (${from},${to})`;
  if (rows.length!==2) return jsonError("snapshot_not_found",404);
  const fromF=new Set<string>((await sql`select p.username from snapshot_followers sf join people p on p.id=sf.person_id where sf.snapshot_id=${from}`).map((r:any)=>String(r.username)));
  const toF=new Set<string>((await sql`select p.username from snapshot_followers sf join people p on p.id=sf.person_id where sf.snapshot_id=${to}`).map((r:any)=>String(r.username)));
  const fromG=new Set<string>((await sql`select p.username from snapshot_following sf join people p on p.id=sf.person_id where sf.snapshot_id=${from}`).map((r:any)=>String(r.username)));
  const toG=new Set<string>((await sql`select p.username from snapshot_following sf join people p on p.id=sf.person_id where sf.snapshot_id=${to}`).map((r:any)=>String(r.username)));
  return c.json({from:rows.find((r:any)=>r.id===from),to:rows.find((r:any)=>r.id===to),followers:{gained:setDifference(toF,fromF),lost:setDifference(fromF,toF)},following:{gained:setDifference(toG,fromG),lost:setDifference(fromG,toG)}});
});

app.get("/api/v1/accounts/:id/people", async c => {
  const q=(c.req.query("q")||"").trim().toLowerCase(), limit=Math.min(100,Math.max(1,Number(c.req.query("limit")||50))), sql=db(c.env);
  if (!q) return c.json({people:[]});
  const rows=await sql`select id,username,first_seen_at,last_seen_at from people where account_id=${c.req.param("id")} and username like ${q+'%'} order by username limit ${limit}`;
  return c.json({people:rows});
});

app.get("/api/v1/accounts/:id/analytics/growth", async c => {
  const rows = await db(c.env)`select observed_at,followers_count,following_count,mutual_count,not_following_back_count,excluded_count from snapshots where account_id=${c.req.param("id")} order by observed_at asc`;
  return c.json({ points: rows });
});

app.get("/api/v1/accounts/:id/analytics/churn", async c => {
  const rows = await db(c.env)`select date_trunc('day',e.occurred_before) day,e.event_type,count(*)::int count from events e where e.account_id=${c.req.param("id")} and e.event_type in ('unfollowed_you','followed_you') and not exists(select 1 from exclusion_entries x join people p on p.account_id=x.account_id and p.username=x.username where x.account_id=e.account_id and p.id=e.person_id) group by 1,e.event_type order by 1 asc`;
  return c.json({ points: rows });
});

app.get("/api/v1/accounts/:id/changes", async c => {
  const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') || 200)));
  const type = c.req.query('type');
  const rows = await db(c.env)`select e.id,e.event_type,p.username,e.occurred_after,e.occurred_before,e.snapshot_id from events e join people p on p.id=e.person_id where e.account_id=${c.req.param("id")} and (${type || null} is null or e.event_type=${type || null}) and not exists(select 1 from exclusion_entries x where x.account_id=e.account_id and x.username=p.username) order by e.occurred_before desc limit ${limit}`;
  return c.json({ count: rows.length, changes: rows });
});

app.get("/api/v1/accounts/:id/people/:username/history", async c => {
  const accountId = c.req.param("id"), username = normalizeUsername(c.req.param("username"));
  if (!username) return jsonError("invalid_username");
  const sql = db(c.env), person = (await sql`select id,username,first_seen_at,last_seen_at from people where account_id=${accountId} and username=${username}`)[0];
  if (!person) return jsonError("person_not_found", 404);
  const history = await sql`select s.id snapshot_id,s.observed_at,exists(select 1 from snapshot_followers sf where sf.snapshot_id=s.id and sf.person_id=${person.id}) follows_you,exists(select 1 from snapshot_following sf where sf.snapshot_id=s.id and sf.person_id=${person.id}) you_follow from snapshots s where s.account_id=${accountId} order by s.observed_at asc`;
  const events = await sql`select event_type,occurred_after,occurred_before from events where account_id=${accountId} and person_id=${person.id} order by occurred_before asc`;
  return c.json({ person, history, events, excluded: Boolean((await sql`select 1 from exclusion_entries where account_id=${accountId} and username=${username}`)[0]) });
});

app.get("/api/v1/accounts/:id/changes/export.csv", async c => {
  const rows = await db(c.env)`select e.event_type,p.username,e.occurred_after,e.occurred_before from events e join people p on p.id=e.person_id where e.account_id=${c.req.param("id")} and not exists(select 1 from exclusion_entries x where x.account_id=e.account_id and x.username=p.username) order by e.occurred_before desc`;
  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"','""')}"`;
  const csv = ['event_type,username,occurred_after,occurred_before', ...rows.map((r: any) => [r.event_type,r.username,r.occurred_after,r.occurred_before].map(esc).join(','))].join('\n');
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="instagram-changes.csv"' } });
});

app.get("/api/v1/accounts/:id/exclusions", async c => {
  const rows = await db(c.env)`select id,username,reason,created_at,updated_at from exclusion_entries where account_id=${c.req.param("id")} order by username`;
  return c.json({ count: rows.length, exclusions: rows });
});

app.post("/api/v1/accounts/:id/exclusions", async c => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const users = uniqueNormalized(Array.isArray(body.usernames) ? body.usernames : []);
  if (!users.length) return jsonError("no_valid_usernames");
  if (users.length > asInt(c.env.MAX_EXCLUSION_COUNT, 100000)) return jsonError("exclusion_limit_exceeded", 413);
  const reason = String(body.reason || 'manually_excluded').slice(0, 80), sql = db(c.env);
  await sql`insert into exclusion_entries(account_id,username,reason) select ${c.req.param("id")}::uuid,value,${reason} from jsonb_array_elements_text(${JSON.stringify(users)}::jsonb) on conflict(account_id,username) do update set reason=excluded.reason,updated_at=now()`;
  await sql`insert into audit_log(account_id,action,details) values(${c.req.param("id")},'exclusions_updated',jsonb_build_object('count',${users.length}))`;
  return c.json({ added_or_updated: users.length, usernames: users });
});

app.post("/api/v1/accounts/:id/exclusions/import", async c => {
  const form = await c.req.formData(), file = form.get('file');
  if (!(file instanceof File)) return jsonError("missing_file");
  const text = await file.text(); let values: any[] = [];
  if (file.name.toLowerCase().endsWith('.json')) { const parsed = JSON.parse(text); values = Array.isArray(parsed) ? parsed : (parsed.usernames || parsed.excluded || []); }
  else values = text.split(/[\r\n,]+/);
  const users = uniqueNormalized(values.map(v => typeof v === 'string' ? v : v?.username ?? v?.title ?? v?.string_list_data?.[0]?.value));
  if (!users.length) return jsonError("no_valid_usernames");
  const sql = db(c.env);
  await sql`insert into exclusion_entries(account_id,username,reason) select ${c.req.param("id")}::uuid,value,'imported' from jsonb_array_elements_text(${JSON.stringify(users)}::jsonb) on conflict(account_id,username) do update set updated_at=now()`;
  return c.json({ imported: users.length, usernames: users });
});

app.delete("/api/v1/accounts/:id/exclusions/:username", async c => {
  const username = normalizeUsername(c.req.param("username")); if (!username) return jsonError("invalid_username");
  const rows = await db(c.env)`delete from exclusion_entries where account_id=${c.req.param("id")} and username=${username} returning id,username`;
  return rows.length ? c.json({ deleted: rows[0] }) : jsonError("not_found", 404);
});

app.post("/api/v1/accounts/:id/exclusions/clear", async c => {
  const result = await db(c.env)`delete from exclusion_entries where account_id=${c.req.param("id")}`;
  return c.json({ deleted: result.length });
});

app.onError((e, c) => { console.error(e); return c.json({ error: "internal_error", message: e instanceof Error ? e.message : String(e) }, 500); });

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ImportQueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === 'finalize') {
          await finalize(env, message.body.importId);
          message.ack();
        } else message.ack();
      } catch (error) {
        console.error('queue import failure', message.body, error);
        message.retry();
      }
    }
  }
};
