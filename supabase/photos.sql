-- À Deux : photos des plats prises par le foyer. À coller dans Supabase > SQL Editor > Run
-- (après schema.sql). Même principe : aucune policy, accès uniquement par fonctions avec le code du foyer.

create table if not exists public.photos (
  code text not null references public.households(code) on delete cascade,
  recipe text not null check (char_length(recipe) between 1 and 60),
  ts bigint not null,
  data text not null check (char_length(data) <= 260000),
  primary key (code, recipe)
);
alter table public.photos enable row level security;
revoke all on public.photos from anon, authenticated;

create or replace function public.photo_put(p_code text, p_recipe text, p_ts bigint, p_data text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.households where code = p_code) then
    return jsonb_build_object('ok', false);
  end if;
  if p_data is null or left(p_data, 23) <> 'data:image/jpeg;base64,' or char_length(p_data) > 260000
     or (select count(*) from public.photos where code = p_code) >= 200 then
    raise exception 'invalid input';
  end if;
  insert into public.photos(code, recipe, ts, data) values (p_code, p_recipe, p_ts, p_data)
    on conflict (code, recipe) do update set ts = excluded.ts, data = excluded.data
    where excluded.ts >= public.photos.ts;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.photo_get(p_code text, p_recipe text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ph public.photos;
begin
  select * into ph from public.photos where code = p_code and recipe = p_recipe;
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'ts', ph.ts, 'data', ph.data);
end $$;

revoke all on function public.photo_put(text, text, bigint, text) from public;
revoke all on function public.photo_get(text, text) from public;
grant execute on function public.photo_put(text, text, bigint, text) to anon, authenticated;
grant execute on function public.photo_get(text, text) to anon, authenticated;
