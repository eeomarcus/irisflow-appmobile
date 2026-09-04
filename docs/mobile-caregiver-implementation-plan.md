# Plano de implementação — Comunicação Paciente ↔ Cuidador

Documento da ETAPA 3. Doze fases pequenas e testáveis. Cada uma termina em um
estado verificável; nenhuma depende de um passo futuro para fazer sentido.

Legenda: **[✓]** entregue neste repositório · **[op]** exige ação do operador
(credencial, conta, dispositivo físico) e por isso não pode ser concluída por mim.

---

## Fase 1 — Base de dados **[✓]**

**Entrega:** `supabase/migrations/0001_comunicacao_core.sql`

Tabelas: `care_patients`, `care_links`, `care_link_invites`, `conversations`,
`messages`, `message_receipts`, `emergency_alerts`, `emergency_alert_events`,
`care_patient_presence`, `device_push_tokens`, `notification_deliveries`.

Tipos: `care_role_t`, `care_link_status_t`, `message_kind_t`, `urgency_t`,
`sender_kind_t`, `emergency_state_t`, `push_platform_t`.

Restrições que carregam regra de negócio, não só integridade:

- `unique (conversation_id, client_message_id)` — idempotência de mensagem.
- `unique (patient_id, client_alert_id)` — idempotência de alerta.
- `unique (patient_id, caregiver_user_id)` em `care_links` — um vínculo por par.
- `unique (patient_id, caregiver_user_id)` em `conversations` — uma conversa por par.
- índice parcial `where state in ('ALERTA_DISPARADO','ENTREGUE','VISUALIZADO')`
  — o "alerta ativo" é consultado a cada disparo e não pode varrer a tabela.

**Aditiva.** Nenhum `drop`, `alter` ou `rename` em tabela existente. Idempotente:
rodar duas vezes não quebra.

**Verificação:** `supabase db lint`; rodar o arquivo duas vezes seguidas.

---

## Fase 2 — Autenticação **[✓]**

Reutiliza Supabase Auth. Sem sistema novo.

- Cuidador: `signInWithPassword`, sessão em `expo-secure-store`.
- Paciente (desktop): sessão de dispositivo em `safeStorage` do Electron.
- `profiles` já existe e já tem trigger de criação no signup — nada a fazer nela.

**Entrega:** `packages/comm-client/src/client.ts` (fábrica de cliente com
adaptador de storage injetável), `apps/caregiver-app/src/lib/session.ts`,
`desktop-integration/utils/patientSession.ts`.

**Verificação:** `client.test.ts` — cliente ausente quando não configurado;
storage adapter é realmente usado; `signOut` limpa o segredo.

---

## Fase 3 — Vínculo paciente ↔ cuidador **[✓]**

O par nunca se forma por e-mail (isso permitiria enumerar usuários). Forma-se
por **código de uso único**:

```
desktop/cuidador-admin                    app do cuidador
──────────────────────                    ───────────────
rpc create_link_invite(patient_id, role)
   → devolve código de 8 caracteres
     (o banco guarda só o SHA-256)
   → expira em 24 h
                          ── código dito por voz/WhatsApp ──►
                                          POST /link-accept { code }
                                             ↓ service role
                                          resolve hash, valida expiração,
                                          cria care_link (active) + conversation,
                                          marca o convite como usado
```

Código alfanumérico sem caracteres ambíguos (`0/O`, `1/I/L`), 8 posições — 32^8
≈ 1,1×10^12 combinações, com expiração curta e uso único. Resposta uniforme para
código inválido, expirado ou já usado: nada distingue os três casos para quem
está adivinhando.

**Entrega:** `0003_rpc.sql` (`create_link_invite`, `revoke_link`),
`supabase/functions/link-accept/index.ts`.

**Verificação:** `supabase/tests/rls.sql` §3 — cuidador sem vínculo enxerga zero
linhas; vínculo `revoked` enxerga zero linhas.

---

## Fase 4 — Conversas e mensagens **[✓]**

`rpc send_message(p_conversation_id, p_client_message_id, p_body, p_kind, p_urgency)`:

1. resolve a conversa e checa `has_patient_access` — 403 se não;
2. deriva `sender_kind` de quem é `auth.uid()` na conversa (o cliente não escolhe);
3. `insert ... on conflict (conversation_id, client_message_id) do nothing`;
4. se não inseriu, **devolve a linha existente** — reenvio é sucesso, não erro;
5. atualiza `conversations.last_message_at`;
6. rate limit de 60 mensagens/min por paciente, exceto `emergencia`.

Leitura: `mark_messages_delivered(ids)` e `mark_messages_read(ids)` gravam em
`message_receipts` com `on conflict do update`, sempre para `auth.uid()`.

**Entrega:** `0003_rpc.sql`, `packages/comm-client/src/messages.ts`.

**Verificação:** `messages.test.ts` — envio duplicado devolve o mesmo id;
remetente forjado é ignorado; recibo é por destinatário.

---

## Fase 5 — Tempo real **[✓]**

Canal por conversa via `postgres_changes`, mais o *catch-up* na reconexão.

O detalhe que quase todo mundo erra: `SUBSCRIBED` não significa "não perdi
nada". `realtime.ts` dispara um `fetchSince(lastSeenAt)` a cada subscrição bem
sucedida e concilia por `client_message_id`, então uma troca de rede não abre
buraco no histórico.

**Entrega:** `0004_realtime.sql` (publicação), `packages/comm-client/src/realtime.ts`.

**Verificação:** `realtime.test.ts` — reconexão dispara catch-up; mensagem
recebida duas vezes (realtime + catch-up) aparece uma vez só.

---

## Fase 6 — App mobile do cuidador **[✓]**

Expo + TypeScript. Cinco telas, nada além disso:

| Tela | Conteúdo |
|---|---|
| `LoginScreen` | e-mail, senha, recuperação |
| `PatientsScreen` | lista de pacientes: nome, status, última mensagem, alerta ativo |
| `LinkPatientScreen` | campo do código de 8 caracteres |
| `ConversationScreen` | histórico, entrega/leitura, campo de texto, respostas rápidas |
| `EmergencyScreen` | alerta em tela cheia + "RECEBI, ESTOU INDO" |

**Verificação:** `npx tsc --noEmit`; `npx expo start` **[op]** — precisa de
dispositivo.

---

## Fase 7 — Push notifications **[✓ código] [op credenciais]**

Edge Function `push-fanout`, acionada por Database Webhook em `messages` e
`emergency_alerts`. Fala com o Expo Push Service. Grava cada ticket em
`notification_deliveries`.

Canais Android criados no primeiro boot: `mensagens`, `urgente`, `emergencia`
(este com `bypassDnd`).

**O que depende do operador e eu não posso fazer:** conta Expo/EAS, chave do
FCM v1 no projeto Android, chave APNs no Apple Developer, e — se quiser
notificação *critical* no iOS — o entitlement `com.apple.developer.usernotifications.critical-alerts`,
que a Apple concede caso a caso. Sem isso o app usa *time-sensitive*, que já
fura o modo Foco, e **avisa o cuidador na tela de status** que o nível crítico
não está ativo. Nada é simulado.

---

## Fase 8 — Emergência **[✓]**

Sequência implementada:

```
paciente fixa o olhar no botão EMERGÊNCIA
   │
   ├─ 5 s de confirmação por fixação (já existe em EmergencyContext)
   │  cancelável com dwell curto — proteção contra acionamento acidental
   ▼
ALARME LOCAL dispara agora  ── som + voz, independe de rede ──────────┐
   │                                                                   │
   ├─ outbox grava o alerta (ENVIANDO)                                 │
   │                                                                   │
   └─ rpc trigger_emergency(client_alert_id, categoria)                │
        │  janela de dedupe de 30 s: reacionar devolve o alerta ativo  │
        ▼                                                              │
      ALERTA_DISPARADO  ──► evento de auditoria                        │
        │                                                              │
        ├─ Realtime ──────────► app aberto: tela cheia imediata        │
        └─ webhook ─► push-fanout ─► push prioridade máxima            │
                                        │                              │
             app do cuidador confirma recebimento (não o ticket!)      │
                    │                                                  │
                    ▼                                                  │
                 ENTREGUE ──► paciente vê "Seu cuidador recebeu"       │
                    │                                                  │
             cuidador abre o alerta                                    │
                    ▼                                                  │
              VISUALIZADO                                              │
                    │                                                  │
             toca "RECEBI, ESTOU INDO"                                 │
                    ▼                                                  │
               CONFIRMADO ──► "Seu cuidador confirmou. Está vindo."    │
                                                                       │
   sem CONFIRMADO em 60 s → emergency-dispatch escala p/ secundários   │
   retentativas esgotadas → FALHA_DE_ENVIO                             │
        └─► "Não consegui avisar pela internet." + alarme segue ───────┘
```

**Entrega:** `0003_rpc.sql` (`trigger_emergency`, `cancel_emergency`,
`acknowledge_emergency`, `mark_emergency_delivered`, `mark_emergency_seen`),
`supabase/functions/emergency-dispatch/index.ts`,
`packages/comm-client/src/emergency.ts`.

**Verificação:** `emergency.test.ts` — transições ilegais recusadas; dedupe;
`FALHA_DE_ENVIO` após esgotar retentativas; alarme local independente do
resultado de rede.

---

## Fase 9 — Integração com o desktop **[✓]**

Arquivos prontos em `desktop-integration/`, para copiar em
`Blinkv1/frontend/src/`. Instruções passo a passo em `docs/integracao-desktop.md`.

Nova tela **"Falar com cuidador"**, na ordem que o §9 pede:

```
┌───────────────────────┬───────────────────────┐
│      EMERGÊNCIA       │     PEDIR AJUDA       │   ← alvos maiores, dwell maior
├───────────────────────┼───────────────────────┤
│         SIM           │         NÃO           │
├───────────────────────┼───────────────────────┤
│    FRASES RÁPIDAS     │      HISTÓRICO        │
└───────────────────────┴───────────────────────┘
```

Seis alvos, dois por linha, `GazeGrid` existente, `alvoMinimoPx()` existente.
Nenhum componente novo de design system — a nova tela usa o que já está lá, que
é o único jeito de ela herdar automaticamente as configurações de dwell e
sensibilidade do paciente.

**A correção da mentira:** `EmergencyEscalation` passa a assinar o estado real
do alerta e a exibir a tabela de textos da §9.2 da arquitetura.

**Verificação:** rodar `npm run verify` no Blinkv1 depois de copiar.

---

## Fase 10 — Testes **[✓]**

`packages/comm-client` — Vitest, mesma configuração do Blinkv1:

| Arquivo | Cobre |
|---|---|
| `client.test.ts` | configuração ausente, storage adapter, logout |
| `outbox.test.ts` | persistência, ordem FIFO, backoff, dedupe, offline→online, `sent` só com ack |
| `messages.test.ts` | envio, duplicata, remetente forjado, entrega, leitura, histórico |
| `emergency.test.ts` | máquina de estados, transições ilegais, dedupe, falha de envio, ack |
| `realtime.test.ts` | reconexão, catch-up, deduplicação de evento |
| `access.test.ts` | permissão negada, vínculo revogado, paciente não vinculado |

`supabase/tests/rls.sql` — testes de RLS executáveis no banco, com os casos
negativos que importam: cuidador B não lê a conversa do paciente A.

**Verificação:** `cd packages/comm-client && npm test`.

---

## Fase 11 — Segurança **[✓ revisão] [op pentest]**

Revisão item a item da §23 na tabela 11.2 da arquitetura. Cada linha tem uma
defesa nomeada e testada.

**Fora do meu alcance:** teste de invasão em ambiente real, revisão de
configuração do projeto Supabase (política de senha, rate limit do GoTrue,
CORS), e a decisão sobre retenção legal dos dados de saúde.

---

## Fase 12 — Build e deploy **[op]**

```bash
# banco
supabase link --project-ref ydnsnbeugxzhpkpqpqhb
supabase db push

# edge functions
supabase functions deploy link-accept push-fanout emergency-dispatch
supabase secrets set EXPO_ACCESS_TOKEN=...

# webhooks (painel: Database > Webhooks)
#   messages          INSERT → push-fanout
#   emergency_alerts  INSERT/UPDATE → push-fanout

# cron do escalonamento (painel: Database > Cron, ou pg_cron)
#   */1 * * * *  →  emergency-dispatch

# app
cd apps/caregiver-app && eas build -p android && eas build -p ios
```

Precisa das suas contas (Supabase, Expo, Google Play, App Store). O que eu podia
preparar — SQL, funções, código, configuração — está pronto.

---

## Ordem sugerida de execução

1. Rodar `0001` … `0004` no SQL Editor e conferir com `supabase/tests/rls.sql`.
2. `npm test` em `packages/comm-client` — a lógica de entrega passa a estar coberta.
3. Copiar `desktop-integration/` para o Blinkv1 e rodar `npm run verify`.
4. Só então cuidar de push e das lojas, que é a parte que depende de terceiros.

Nessa ordem, o sistema já é útil no passo 3: o paciente comunica e o cuidador vê
pelo Realtime com o app aberto. O push da fase 7 melhora o alcance; não é
pré-requisito para o valor.
