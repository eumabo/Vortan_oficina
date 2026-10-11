# Vortan Oficina — Security Hardening

Alterações feitas sem mudar o fluxo visual ou a estrutura funcional do SaaS:

- headers HTTP de segurança na API e no deploy Vercel;
- rate limiting conservador por origem para leitura, mutações, billing, admin e rota pública;
- logs de requisição desligados por padrão e token público da OS redigido quando debug é habilitado;
- limite de tamanho e validação de JSON;
- validação de UUIDs antes de operações por ID;
- validação de strings, datas, valores financeiros, tipo de lançamento e status de OS;
- autorização por `workshop_id` preservada em todas as operações multi-tenant;
- rota pública da OS continua expondo apenas campos necessários e vincula cliente/veículo à mesma oficina;
- erros internos deixam de expor detalhes do banco/serviços para o navegador;
- assinatura do webhook Mercado Pago continua obrigatória e agora também possui janela anti-replay de 15 min;
- idempotência de webhook/pagamentos preservada;
- uploads de logo e fotos aceitam somente PNG/JPG/WEBP com limites de tamanho e nomes de arquivo seguros;
- `supabase/functions/server/index.tsx` sincronizado com `rapid-action/index.tsx` para não haver uma versão local mais fraca que a de produção;
- nenhum pacote novo foi adicionado e nenhuma migração destrutiva foi introduzida.

## Camada opcional de banco

`SUPABASE_SECURITY_HARDENING.sql` reforça RLS/Storage para fotos de OS e logos. Ele não é executado automaticamente pelo ZIP; isso evita alterar o banco remoto sem revisão/deploy explícito.

## Observação sobre rate limit

O limiter em memória é uma defesa adicional por instância da Edge Function. Para proteção distribuída forte contra abuso volumétrico, use também rate limiting/WAF na borda da infraestrutura.

## Security V2

- política de senha do frontend alinhada em cadastro e redefinição: 8+ caracteres, maiúscula, minúscula e número;
- CSP de produção adicionada ao Vercel com allowlist para Supabase, Google Fonts e ViaCEP;
- headers adicionais: COOP e DNS prefetch desativado;
- criado `SECURITY_V2_DEPLOY_CHECKLIST.md` com os passos que dependem da configuração real do Supabase/Vercel/Mercado Pago e não devem ser automatizados pelo ZIP.

MFA de admin **não foi forçado no código** para evitar lockout antes de existir um segundo fator cadastrado. O checklist explica a ordem segura para habilitar.
