-- À Deux : stockage partagé d'un foyer. À coller dans Supabase > SQL Editor > Run.
-- La table n'a aucune policy : elle n'est accessible que par les deux fonctions ci-dessous,
-- qui exigent le code du foyer (secret partagé entre les téléphones).

create table if not exists public.households (
  code text primary key check (char_length(code) between 8 and 32),
  data jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.households enable row level security;
revoke all on public.households from anon, authenticated;

-- Lecture : renvoie les données seulement si elles sont plus récentes que p_rev.
create or replace function public.household_get(p_code text, p_rev bigint default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  select * into h from public.households where code = p_code;
  if not found then return jsonb_build_object('found', false); end if;
  if h.rev <= p_rev then return jsonb_build_object('found', true, 'rev', h.rev); end if;
  return jsonb_build_object('found', true, 'rev', h.rev, 'data', h.data);
end $$;

-- Écriture : p_rev = 0 crée le foyer ; sinon met à jour seulement si la révision n'a pas bougé.
-- En cas de conflit, renvoie l'état actuel pour que l'app fusionne et réessaie.
create or replace function public.household_put(p_code text, p_data jsonb, p_rev bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if p_code is null or char_length(p_code) not between 8 and 32
     or p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 300000 then
    raise exception 'invalid input';
  end if;
  if p_rev = 0 then
    insert into public.households(code, data) values (p_code, p_data) on conflict (code) do nothing;
    if found then return jsonb_build_object('ok', true, 'rev', 1); end if;
  else
    update public.households set data = p_data, rev = rev + 1, updated_at = now()
      where code = p_code and rev = p_rev returning * into h;
    if found then return jsonb_build_object('ok', true, 'rev', h.rev); end if;
  end if;
  select * into h from public.households where code = p_code;
  if not found then return jsonb_build_object('ok', false, 'found', false); end if;
  return jsonb_build_object('ok', false, 'found', true, 'rev', h.rev, 'data', h.data);
end $$;

revoke all on function public.household_get(text, bigint) from public;
revoke all on function public.household_put(text, jsonb, bigint) from public;
grant execute on function public.household_get(text, bigint) to anon, authenticated;
grant execute on function public.household_put(text, jsonb, bigint) to anon, authenticated;
