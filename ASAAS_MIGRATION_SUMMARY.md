# Migração de billing — Asaas

## Alterações aplicadas

### Frontend
- Removido o SDK/formulário de cartão do fluxo anterior.
- Removidas variáveis públicas do meio de pagamento.
- `Assinar plano mensal` abre Checkout hospedado Asaas recorrente.
- `Pagar apenas este mês` abre Checkout hospedado Asaas avulso.
- Cancelamento usa o helper central da API.
- Nenhum dado de cartão passa pela Vortan.

### Backend / Supabase Edge Function
- A Vortan **não cria cliente Asaas antes do primeiro Checkout**, porque o app não coleta CPF/CNPJ.
- O Checkout hospedado coleta os dados obrigatórios do pagador no ambiente do Asaas.
- Depois do primeiro pagamento, o `customer_id` é reutilizado em novos Checkouts; o backend valida esse ID no ambiente atual para não misturar Sandbox e Produção.
- `billing_checkout_sessions` guarda o vínculo `checkout_id → user_id` até a conciliação dos webhooks.
- O backend reconcilia o Checkout com cobranças via `checkoutSession` e salva `customer_id` / `subscription_id` quando disponíveis.
- Checkout avulso: Pix ou cartão.
- Checkout recorrente: cartão + `RECURRENT` + `MONTHLY`.
- API Key fica somente em Supabase Secrets.
- Webhook protegido por `ASAAS_WEBHOOK_TOKEN` / header `asaas-access-token`.
- Pagamentos confirmados/recebidos liberam ou prorrogam o acesso por 1 mês.
- Deduplicação usa `billing_webhook_events` e também `subscriptions.last_payment_id`, evitando somar duas vezes em `PAYMENT_CONFIRMED` + `PAYMENT_RECEIVED`.
- Eventos de assinatura sincronizam IDs e status sem liberar acesso sozinhos.
- Cancelamento encerra a recorrência no Asaas e preserva o período já pago.

### Banco
`ASAAS_BILLING_MIGRATION.sql` adiciona campos genéricos em `subscriptions`:
- `billing_provider`
- `provider_customer_id`
- `provider_subscription_id`
- `provider_checkout_id`
- `last_payment_id`
- `last_payment_at`

Também cria `billing_checkout_sessions` com RLS ativo e sem policy de cliente, para uso exclusivo da Edge Function/service role.

Nenhuma coluna antiga é removida.

## Arquivos principais alterados
- `src/app/App.tsx`
- `src/lib/api.ts`
- `supabase/functions/rapid-action/index.ts`
- `supabase/functions/server/index.tsx`
- `package.json`
- `package-lock.json`
- `.env.local`

## Arquivos adicionados
- `ASAAS_BILLING_MIGRATION.sql`
- `ASAAS_SETUP.md`
- `ASAAS_MIGRATION_SUMMARY.md`

## Validações esperadas antes de produção
- busca global sem referências de código ao SDK/API do provedor anterior;
- `package.json` e `package-lock.json` válidos e consistentes;
- parse/transpile TypeScript dos arquivos alterados;
- nenhuma API Key do Asaas inserida no repositório;
- `npm install` + `npm run build` no ambiente local/CI;
- teste completo no Sandbox antes da troca para produção.
