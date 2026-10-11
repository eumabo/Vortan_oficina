-- Vortan Oficina — hardening adicional de RLS/Storage.
-- OPCIONAL: o ZIP funciona sem rodar este arquivo.
-- Rode no Supabase SQL Editor para reforçar a camada de banco dos uploads diretos do front-end.

-- 1) A foto só pode apontar para uma OS da própria oficina autenticada.
alter table if exists public.af_order_photos enable row level security;

drop policy if exists "order photos insert own workshop" on public.af_order_photos;
create policy "order photos insert own workshop"
  on public.af_order_photos for insert
  with check (
    auth.uid() = workshop_id
    and exists (
      select 1
      from public.af_service_orders so
      where so.id = order_id
        and so.workshop_id = auth.uid()
    )
  );

drop policy if exists "order photos select own workshop" on public.af_order_photos;
create policy "order photos select own workshop"
  on public.af_order_photos for select
  using (
    auth.uid() = workshop_id
    and exists (
      select 1
      from public.af_service_orders so
      where so.id = order_id
        and so.workshop_id = auth.uid()
    )
  );

drop policy if exists "order photos delete own workshop" on public.af_order_photos;
create policy "order photos delete own workshop"
  on public.af_order_photos for delete
  using (
    auth.uid() = workshop_id
    and exists (
      select 1
      from public.af_service_orders so
      where so.id = order_id
        and so.workshop_id = auth.uid()
    )
  );

-- 2) Storage de fotos: usuário só grava/remove dentro da própria pasta raiz.
drop policy if exists "order photos storage insert own folder" on storage.objects;
create policy "order photos storage insert own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'order-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "order photos storage delete own folder" on storage.objects;
create policy "order photos storage delete own folder"
  on storage.objects for delete
  using (
    bucket_id = 'order-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- 3) Logo da oficina: mantém leitura pública, mas escrita/remoção só na pasta do usuário.
insert into storage.buckets (id, name, public)
values ('workshop-logos', 'workshop-logos', true)
on conflict (id) do update set public = true;

drop policy if exists "workshop logos public read" on storage.objects;
create policy "workshop logos public read"
  on storage.objects for select
  using (bucket_id = 'workshop-logos');

drop policy if exists "workshop logos insert own folder" on storage.objects;
create policy "workshop logos insert own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'workshop-logos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "workshop logos update own folder" on storage.objects;
create policy "workshop logos update own folder"
  on storage.objects for update
  using (
    bucket_id = 'workshop-logos'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'workshop-logos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "workshop logos delete own folder" on storage.objects;
create policy "workshop logos delete own folder"
  on storage.objects for delete
  using (
    bucket_id = 'workshop-logos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
