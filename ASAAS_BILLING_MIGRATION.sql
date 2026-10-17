-- Vortan Oficina - migração segura de billing para Asaas
-- Não remove colunas antigas do provedor anterior para evitar quebra/rollback.

alter table if exists public.subscriptions
  add column if not exists billing_provider text,
  add column if not exists provider_customer_id text,
  add column if not exists provider_subscription_id text,
  add column if not exists provider_checkout_id text,
  add column if not exists last_payment_id text,
  add column if not exists last_payment_at timestamptz;

create index if not exists subscriptions_provider_customer_idx
  on public.subscriptions (provider_customer_id);

create index if not exists subscriptions_provider_subscription_idx
  on public.subscriptions (provider_subscription_id);

create index if not exists subscriptions_provider_checkout_idx
  on public.subscriptions (provider_checkout_id);

-- O Checkout hospedado pode criar/associar o cliente no Asaas depois que o
-- usuário informa CPF/CNPJ. Esta tabela mantém o vínculo seguro entre o ID do
-- Checkout do Asaas e o usuário da Vortan até os webhooks de pagamento chegarem.
create table if not exists public.billing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  checkout_id text not null,
  user_id uuid not null,
  mode text not null check (mode in ('single', 'subscription')),
  status text not null default 'created',
  external_reference text,
  customer_id text,
  subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, checkout_id)
);

alter table public.billing_checkout_sessions enable row level security;

-- Sem policy de cliente de propósito: esta tabela é de infraestrutura de billing
-- e é acessada somente pela Edge Function via service role.
create index if not exists billing_checkout_sessions_user_idx
  on public.billing_checkout_sessions (user_id, created_at desc);

create index if not exists billing_checkout_sessions_customer_idx
  on public.billing_checkout_sessions (provider, customer_id);

create index if not exists billing_checkout_sessions_subscription_idx
  on public.billing_checkout_sessions (provider, subscription_id);

-- billing_webhook_events já existe no projeto e continua sendo reutilizada
-- para idempotência dos webhooks.
