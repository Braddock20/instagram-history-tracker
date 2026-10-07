create extension if not exists pgcrypto;

create table if not exists instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  username text,
  display_name text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists imports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_accounts(id) on delete cascade,
  original_filename text not null,
  sha256 text,
  observed_at timestamptz not null default now(),
  status text not null check (status in ('staging','queued','processing','valid','valid_with_warnings','duplicate','invalid','failed')),
  parser_version text not null,
  snapshot_id uuid,
  discovered_files jsonb not null default '[]'::jsonb,
  follower_files jsonb not null default '[]'::jsonb,
  following_files jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  followers_count integer,
  following_count integer,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(account_id, sha256)
);

create table if not exists import_usernames (
  import_id uuid not null references imports(id) on delete cascade,
  username text not null,
  relationship text not null check (relationship in ('follower','following')),
  primary key(import_id, username, relationship)
);

create table if not exists snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_accounts(id) on delete cascade,
  import_id uuid not null unique references imports(id) on delete restrict,
  observed_at timestamptz not null default now(),
  followers_count integer not null,
  following_count integer not null,
  mutual_count integer not null default 0,
  not_following_back_count integer not null default 0,
  excluded_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table imports drop constraint if exists imports_snapshot_fk;
alter table imports add constraint imports_snapshot_fk foreign key (snapshot_id) references snapshots(id) on delete set null;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_accounts(id) on delete cascade,
  username text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(account_id, username)
);

create table if not exists snapshot_followers (
  snapshot_id uuid not null references snapshots(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  primary key(snapshot_id, person_id)
);

create table if not exists snapshot_following (
  snapshot_id uuid not null references snapshots(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  primary key(snapshot_id, person_id)
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_accounts(id) on delete cascade,
  snapshot_id uuid not null references snapshots(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  event_type text not null check (event_type in ('followed_you','unfollowed_you','you_followed','you_unfollowed')),
  occurred_after timestamptz,
  occurred_before timestamptz not null,
  created_at timestamptz not null default now(),
  unique(snapshot_id, person_id, event_type)
);

create table if not exists exclusion_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_accounts(id) on delete cascade,
  username text not null,
  reason text not null default 'manually_excluded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, username)
);

create table if not exists audit_log (
  id bigserial primary key,
  account_id uuid references instagram_accounts(id) on delete cascade,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_imports_account_created on imports(account_id, created_at desc);
create index if not exists idx_imports_status on imports(status);
create index if not exists idx_import_usernames_import on import_usernames(import_id);
create index if not exists idx_import_usernames_username on import_usernames(import_id, username);
create index if not exists idx_snapshots_account_observed on snapshots(account_id, observed_at desc);
create index if not exists idx_people_account_username on people(account_id, username);
create index if not exists idx_people_account_last_seen on people(account_id, last_seen_at desc);
create index if not exists idx_followers_snapshot on snapshot_followers(snapshot_id);
create index if not exists idx_following_snapshot on snapshot_following(snapshot_id);
create index if not exists idx_events_account_time on events(account_id, occurred_before desc);
create index if not exists idx_events_person_time on events(person_id, occurred_before desc);
create index if not exists idx_exclusions_account_username on exclusion_entries(account_id, username);

create or replace view latest_snapshots as
select distinct on (account_id) id, account_id, import_id, observed_at, followers_count, following_count, mutual_count, not_following_back_count, excluded_count
from snapshots order by account_id, observed_at desc;

create or replace function finalize_import(p_import_id uuid)
returns jsonb
language plpgsql
as $$
declare
  imp imports%rowtype;
  snap_id uuid;
  previous_snapshot_id uuid;
  previous_observed_at timestamptz;
  followers integer;
  following integer;
  mutual integer;
  nfb integer;
  excluded integer;
begin
  select * into imp from imports where id = p_import_id for update;
  if not found then raise exception 'import_not_found'; end if;
  if imp.status = 'valid' or imp.status = 'valid_with_warnings' then
    return jsonb_build_object('status', imp.status, 'snapshot_id', imp.snapshot_id);
  end if;
  if imp.status not in ('staging','queued','processing') then raise exception 'import_not_ready:%', imp.status; end if;

  update imports set status='processing', started_at=coalesce(started_at, now()) where id=p_import_id;

  select id, observed_at into previous_snapshot_id, previous_observed_at
  from snapshots where account_id=imp.account_id order by observed_at desc limit 1;

  select count(*) into followers from import_usernames where import_id=p_import_id and relationship='follower';
  select count(*) into following from import_usernames where import_id=p_import_id and relationship='following';
  if followers=0 or following=0 then raise exception 'empty_relationship'; end if;

  insert into snapshots(account_id, import_id, observed_at, followers_count, following_count)
  values(imp.account_id, imp.id, imp.observed_at, followers, following)
  returning id into snap_id;

  insert into people(account_id, username, first_seen_at, last_seen_at)
  select imp.account_id, username, imp.observed_at, imp.observed_at
  from (select distinct username from import_usernames where import_id=p_import_id) x
  on conflict(account_id, username) do update set last_seen_at=excluded.last_seen_at;

  insert into snapshot_followers(snapshot_id, person_id)
  select snap_id, p.id from import_usernames i join people p on p.account_id=imp.account_id and p.username=i.username
  where i.import_id=p_import_id and i.relationship='follower' on conflict do nothing;

  insert into snapshot_following(snapshot_id, person_id)
  select snap_id, p.id from import_usernames i join people p on p.account_id=imp.account_id and p.username=i.username
  where i.import_id=p_import_id and i.relationship='following' on conflict do nothing;

  if previous_snapshot_id is not null then
    insert into events(account_id,snapshot_id,person_id,event_type,occurred_after,occurred_before)
    select imp.account_id,snap_id,p.id,'followed_you',previous_observed_at,imp.observed_at
    from snapshot_followers cur join people p on p.id=cur.person_id
    where cur.snapshot_id=snap_id and not exists(select 1 from snapshot_followers old where old.snapshot_id=previous_snapshot_id and old.person_id=p.id)
    on conflict do nothing;

    insert into events(account_id,snapshot_id,person_id,event_type,occurred_after,occurred_before)
    select imp.account_id,snap_id,p.id,'unfollowed_you',previous_observed_at,imp.observed_at
    from snapshot_followers old join people p on p.id=old.person_id
    where old.snapshot_id=previous_snapshot_id and not exists(select 1 from snapshot_followers cur where cur.snapshot_id=snap_id and cur.person_id=p.id)
    on conflict do nothing;

    insert into events(account_id,snapshot_id,person_id,event_type,occurred_after,occurred_before)
    select imp.account_id,snap_id,p.id,'you_followed',previous_observed_at,imp.observed_at
    from snapshot_following cur join people p on p.id=cur.person_id
    where cur.snapshot_id=snap_id and not exists(select 1 from snapshot_following old where old.snapshot_id=previous_snapshot_id and old.person_id=p.id)
    on conflict do nothing;

    insert into events(account_id,snapshot_id,person_id,event_type,occurred_after,occurred_before)
    select imp.account_id,snap_id,p.id,'you_unfollowed',previous_observed_at,imp.observed_at
    from snapshot_following old join people p on p.id=old.person_id
    where old.snapshot_id=previous_snapshot_id and not exists(select 1 from snapshot_following cur where cur.snapshot_id=snap_id and cur.person_id=p.id)
    on conflict do nothing;
  end if;

  select count(*) into mutual from snapshot_following a join snapshot_followers b on b.snapshot_id=snap_id and b.person_id=a.person_id where a.snapshot_id=snap_id;
  select count(*) into excluded from exclusion_entries where account_id=imp.account_id and username in (select username from people p join snapshot_following sf on sf.person_id=p.id where sf.snapshot_id=snap_id);
  select count(*) into nfb from snapshot_following a join people p on p.id=a.person_id where a.snapshot_id=snap_id and not exists(select 1 from snapshot_followers b where b.snapshot_id=snap_id and b.person_id=a.person_id) and not exists(select 1 from exclusion_entries e where e.account_id=imp.account_id and e.username=p.username);

  update snapshots set mutual_count=mutual, not_following_back_count=nfb, excluded_count=excluded where id=snap_id;
  update imports set status=case when jsonb_array_length(warnings)>0 then 'valid_with_warnings' else 'valid' end,
    snapshot_id=snap_id, followers_count=followers, following_count=following, completed_at=now() where id=p_import_id;
  insert into audit_log(account_id,action,details) values(imp.account_id,'import_finalized',jsonb_build_object('import_id',p_import_id,'snapshot_id',snap_id,'followers',followers,'following',following));
  delete from import_usernames where import_id=p_import_id;

  return jsonb_build_object('status',(select status from imports where id=p_import_id),'snapshot_id',snap_id,'followers_count',followers,'following_count',following,'mutual_count',mutual,'not_following_back_count',nfb);
exception when others then
  update imports set status='failed', errors=jsonb_build_array(sqlerrm), completed_at=now() where id=p_import_id;
  return jsonb_build_object('status','failed','error',sqlerrm);
end;
$$;
