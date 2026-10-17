# Asaas — setup da Vortan Oficina

A integração foi migrada para **Checkout hospedado do Asaas**. A Vortan não recebe, armazena nem tokeniza dados de cartão.

## 1. Banco
Execute `ASAAS_BILLING_MIGRATION.sql` no SQL Editor do Supabase **antes** de publicar a Edge Function.

A migração:
- adiciona campos genéricos de billing em `subscriptions`;
- cria `billing_checkout_sessions`, que liga cada Checkout Asaas ao usuário Vortan;
- mantém as colunas antigas para permitir rollback sem destruir dados existentes.

A tabela `billing_checkout_sessions` fica com RLS ativo e sem policy de acesso pelo cliente. Ela é usada somente pela Edge Function com service role.

### Por que existe `billing_checkout_sessions`?
A Vortan hoje não coleta CPF/CNPJ. Como esse dado é necessário no cadastro do pagador, o backend **não cria o cliente Asaas antes do primeiro checkout**. O Checkout hospedado coleta os dados do pagador e, depois, os webhooks são conciliados pelo `checkout_id`, `customer_id` e `subscription_id`.

Depois que um `customer_id` válido já foi associado, ele é reutilizado nos próximos Checkouts. Antes de reutilizar, o backend consulta o cliente no ambiente Asaas atual; assim, um ID criado no Sandbox não é reaproveitado por engano em Produção.

## 2. Secrets da Edge Function
Nunca coloque a API Key do Asaas no frontend, `.env.local`, Vercel ou GitHub.

Configure no Supabase:

```powershell
supabase secrets set ASAAS_API_KEY="SUA_CHAVE" --project-ref kddlzartfawqjnrafzdb
supabase secrets set ASAAS_WEBHOOK_TOKEN="UM_TOKEN_ALEATORIO_COM_32_OU_MAIS_CARACTERES" --project-ref kddlzartfawqjnrafzdb
supabase secrets set APP_BASE_URL="https://www.vortanoficina.com.br" --project-ref kddlzartfawqjnrafzdb
supabase secrets set VORTAN_MONTHLY_PRICE="29.90" --project-ref kddlzartfawqjnrafzdb
```

`ASAAS_WEBHOOK_TOKEN` deve ser um token aleatório próprio para o webhook. **Não use a API Key do Asaas como token do webhook.**

### Sandbox — faça o primeiro teste aqui

```powershell
supabase secrets set ASAAS_API_URL="https://api-sandbox.asaas.com/v3" --project-ref kddlzartfawqjnrafzdb
```

Use uma **API Key criada no Sandbox**.

### Produção

```powershell
supabase secrets set ASAAS_API_URL="https://api.asaas.com/v3" --project-ref kddlzartfawqjnrafzdb
```

Troque também `ASAAS_API_KEY` por uma **API Key de produção**. Sandbox e produção não podem ser misturados.

## 3. Webhook Asaas
Cadastre a URL final, sem redirect:

`https://kddlzartfawqjnrafzdb.supabase.co/functions/v1/rapid-action/billing/webhook`

Use como `authToken` exatamente o mesmo valor de `ASAAS_WEBHOOK_TOKEN`. O Asaas enviará esse valor no header `asaas-access-token`.

Se o painel permitir escolher o tipo de envio, prefira **SEQUENTIALLY** para preservar a ordem dos eventos.

Eventos usados pela Vortan:

- PAYMENT_CONFIRMED
- PAYMENT_RECEIVED
- PAYMENT_OVERDUE
- PAYMENT_CREDIT_CARD_CAPTURE_REFUSED
- PAYMENT_REFUNDED
- PAYMENT_CHARGEBACK_REQUESTED
- PAYMENT_CHARGEBACK_DISPUTE
- SUBSCRIPTION_CREATED
- SUBSCRIPTION_UPDATED
- SUBSCRIPTION_INACTIVATED
- SUBSCRIPTION_DELETED
- CHECKOUT_CREATED
- CHECKOUT_PAID
- CHECKOUT_CANCELED
- CHECKOUT_EXPIRED

O backend usa o ID do evento + tabela `billing_webhook_events` para idempotência. O callback do navegador **nunca** libera acesso.

Para `CHECKOUT_PAID`, o backend também consulta as cobranças pelo `checkoutSession` para recuperar com segurança os IDs de cliente/assinatura e reconciliar o pagamento quando possível.

## 4. Deploy da Edge Function

```powershell
supabase functions deploy rapid-action --project-ref kddlzartfawqjnrafzdb --no-verify-jwt
```

O `--no-verify-jwt` é necessário porque o webhook externo do Asaas não possui JWT Supabase. As rotas privadas continuam validando o `Bearer` do usuário dentro da própria função.

## 5. Frontend
`.env.local` precisa apenas de:

```env
VITE_API_BASE=https://kddlzartfawqjnrafzdb.supabase.co/functions/v1/rapid-action
```

Depois:

```powershell
npm install
npm run build
npm run dev
```

Não existe mais SDK nem chave pública do meio de pagamento no frontend.

## 6. Fluxos finais
- **Assinar plano mensal:** Checkout Asaas com cartão, `RECURRENT` e ciclo `MONTHLY`.
- **Pagar apenas este mês:** Checkout Asaas avulso (`DETACHED`) com Pix ou cartão.
- **Dados do pagador:** CPF/CNPJ e cartão são tratados no Checkout hospedado do Asaas, não na Vortan.
- **Liberação:** somente após confirmação/recebimento de cobrança pelo webhook Asaas.
- **Callback:** serve apenas para devolver o usuário ao site; não libera acesso.
- **Cancelamento:** `DELETE /v3/subscriptions/{id}`. O usuário mantém o acesso já pago até `expires_at`.

## 7. Checklist antes de produção
1. Rodar `ASAAS_BILLING_MIGRATION.sql`.
2. Configurar secrets usando **Sandbox**.
3. Configurar o webhook no Sandbox com o mesmo `ASAAS_WEBHOOK_TOKEN`.
4. Fazer deploy da Edge Function.
5. Testar Checkout avulso e confirmar ativação por webhook.
6. Testar Checkout recorrente e confirmar `provider_customer_id` e `provider_subscription_id` em `subscriptions`.
7. Testar cancelamento da assinatura.
8. Rodar `npm run build` e testar o frontend.
9. Só então trocar URL/API Key para produção e publicar o frontend final.
