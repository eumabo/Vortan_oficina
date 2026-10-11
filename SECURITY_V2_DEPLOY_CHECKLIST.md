# Vortan Oficina — Security V2 / Checklist de deploy

Esta versão endurece o código sem alterar o fluxo funcional da aplicação.

## O que foi reforçado no código

- Senha de cadastro e redefinição: mínimo 8 caracteres, com maiúscula, minúscula e número.
- CSP no Vercel compatível com os recursos externos atualmente usados pela Vortan (Supabase, Google Fonts e ViaCEP).
- `frame-ancestors 'none'`, `object-src 'none'`, HSTS, COOP e demais headers defensivos.
- Mantidos os controles da V1: validação de payload, UUID, rate limit, CORS restrito, erros genéricos, anti-replay do Mercado Pago e autorização por `workshop_id`.
- Nenhuma migração destrutiva e nenhuma mudança de layout.

## Faça isto no Supabase (obrigatório para completar a camada de banco)

1. Abra **SQL Editor** no projeto da Vortan.
2. Revise e execute `SUPABASE_SECURITY_HARDENING.sql` uma única vez.
3. Em **Authentication > Sign In / Password security**, configure a senha mínima para **8 caracteres** (ou mais) e habilite proteção contra senhas comprometidas, se disponível no seu plano/projeto.
4. Em **Authentication > Rate Limits**, mantenha limites conservadores para login, cadastro, recuperação de senha e OTP.
5. Confirme que **leaked password protection** / proteção de senha vazada está habilitada, se disponível.

## Admin: MFA recomendado

O código não força MFA automaticamente para não bloquear a conta administrativa atual sem um segundo fator já cadastrado.

Para o admin, habilite MFA no Supabase e cadastre pelo menos um fator TOTP. Depois de confirmar que o admin consegue entrar com MFA, a aplicação pode receber uma etapa futura que exija AAL2 somente nas rotas administrativas.

## Vercel / domínio

- Use somente HTTPS.
- Confirme que `vortanoficina.com.br` e `www.vortanoficina.com.br` são os domínios de produção esperados.
- Não exponha `SUPABASE_SERVICE_ROLE_KEY` em variáveis que começam com `VITE_`.
- Mantenha a service-role somente nas Supabase Edge Functions.

## Mercado Pago

- Confirme que `MERCADO_PAGO_WEBHOOK_SECRET` está configurado como segredo da Edge Function.
- Não use o access token do Mercado Pago no frontend.
- Faça um pagamento de teste e confirme que o webhook retorna 2xx e que eventos repetidos não duplicam cobrança/ativação.

## Teste rápido depois do deploy

1. Login normal.
2. Cadastro com senha fraca deve ser recusado.
3. Criar cliente e veículo.
4. Criar orçamento e converter em OS.
5. Abrir link público da OS.
6. Anexar/remover foto da OS.
7. Alterar logo da oficina.
8. Abrir Financeiro.
9. Abrir Admin com a conta admin.
10. Fazer checkout de teste.

Se algum recurso externo novo for adicionado depois (analytics, mapas, outra API, CDN etc.), atualize a CSP em `vercel.json` para liberar somente o domínio necessário.
