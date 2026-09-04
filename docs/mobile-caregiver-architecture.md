# Arquitetura — Comunicação Paciente ↔ Cuidador

Documento da ETAPA 2. Descreve o que existe hoje, o que está sendo construído e
**por que** cada decisão foi tomada. Escrito para ser lido antes do código.

---

## 1. Arquitetura atual (auditoria)

### 1.1 `Desktop/blink/Blinkv1` — aplicação principal, usada pelo paciente

| Camada | Tecnologia |
|---|---|
| Shell | Electron 43 (`electron/main.ts`, `electron/preload.ts`, build por esbuild) |
| Frontend | React 19 + TypeScript 6 + Vite 8 + Tailwind 4 |
| Roteamento | `HashRouter` — obrigatório, porque o app empacotado roda sob `file://` |
| Visão computacional | `@mediapipe/tasks-vision` + `onnxruntime-web` (L2CS), **100% local** |
| Estado global | React Context: `Gaze`, `Auth`, `Settings`, `Emergency`, `Reminder`, `Toast` |
| Design system | `GazeButton`, `GazeGrid`, `GazePageLayout`, `gazeMetrics.alvoMinimoPx()` |
| Testes | Vitest + Testing Library + jsdom; `npm run verify` = lint + type-check + test + build |
| Persistência | `localStorage` (perfil, configurações, diário do cuidador) |
| Backend | **Nenhum.** |

O pipeline de olhar vive em `src/{capture,preprocess,pose,l2cs,filters,calibration,tracker,interaction}`.
**Nada disso é tocado por esta funcionalidade.**

### 1.2 `Desktop/irisflow-site` — site institucional e de contratação

React 18 + Vite 5 + `@supabase/supabase-js`. Cliente em `src/lib/supabase.ts`,
schema versionado em `supabase/schema.sql`.

### 1.3 Supabase — projeto `ydnsnbeugxzhpkpqpqhb` ("Site Iris Flow", us-east-2)

Oito tabelas, **todas com RLS habilitada**:

```
plans · profiles · beneficiaries · subscriptions
payment_methods · charges · contact_messages · app_releases
```

Duas importam diretamente:

- **`profiles`** — `id uuid primary key references auth.users(id)`. É a conta.
  Quem compra e quem cuida. Já existe autenticação real por trás dela.
- **`beneficiaries`** — comentário da própria tabela: *"Pessoa que opera a
  IrisFlow. Contém dado sensível de saúde (LGPD art. 5º, II)."* É o paciente,
  já modelado, já separado de quem paga.

O schema existente já tomou a decisão certa de separar "quem paga" de "quem
usa". A comunicação se pendura nessa separação em vez de refazê-la.

### 1.4 Três defeitos encontrados no código existente

Registrados aqui porque bloqueiam a funcionalidade — a regra §25.15 do briefing
pede que sejam informados antes de qualquer solução paralela.

1. **O backend que o desktop chama não existe.**
   `frontend/src/config/env.ts` aponta `apiUrl` para `http://localhost:8000/api`
   e não há servidor algum no repositório. `sendHelpAlert`, `sendIAmOk`,
   `chatbotMessage` e `synthesize` falham sempre.

2. **A tela de emergência afirma uma entrega que nunca aconteceu.**
   Em `pages/output/EmergencyEscalation.tsx`:

   ```ts
   api.sendHelpAlert(...).catch((e) => { console.warn(...) });
   ```

   O `catch` engole a falha e a interface exibe *"Seu alerta foi enviado.
   Aguarde atendimento."* mesmo sem servidor. É exatamente o que o §13 do
   briefing proíbe: *"Nunca mostrar 'enviado' se o servidor não confirmou."*
   Para uma pessoa com ELA sozinha em casa, essa mensagem é uma falsa garantia.

3. **A autenticação é um placeholder.**
   `AuthContext` usa `mockProfiles` fixos, PIN de cuidador embutido no bundle
   (`VITE_CAREGIVER_PIN`, padrão `1234`) e `authToken = 'local-caregiver-session'`.
   O próprio arquivo marca isso como `TEMPORÁRIO`.

Os três são corrigidos por esta entrega, sem reescrever nada em volta.

---

## 2. Decisões de arquitetura

### 2.1 Backend: reutilizar o Supabase existente

**Decisão:** nenhum backend novo. Postgres + Auth + Realtime + Edge Functions
do projeto Supabase que a IrisFlow já opera.

**Por quê.** O briefing (§3) manda descobrir a infraestrutura antes de escolher
tecnologia, e proíbe criar uma segunda arquitetura quando já existe uma
adequada. O que a comunicação precisa e o Supabase já entrega:

| Necessidade | Já existe |
|---|---|
| Autenticação, sessão persistente, refresh, recuperação | Supabase Auth (GoTrue) |
| Isolamento entre pacientes / anti-IDOR | Row Level Security no Postgres |
| Tempo real com reconexão | Supabase Realtime (Phoenix Channels) |
| Persistência e histórico | Postgres |
| Lógica privilegiada (push, ack de emergência) | Edge Functions (Deno) |
| Criptografia em trânsito e em repouso | TLS + AES-256 no storage gerenciado |

**Alternativa descartada:** FastAPI em `localhost:8000`, sugerido pelo
`utils/api.ts` atual. Exigiria hospedagem, autenticação própria, WebSocket
próprio, camada de autorização escrita à mão (onde o IDOR normalmente nasce) e
um segundo cadastro de usuários. Nada disso compra algo que o Supabase não dê.

**A consequência que mais importa:** com RLS, a autorização mora no banco, não
na aplicação. Um bug no app mobile não consegue vazar a conversa de outro
paciente, porque o Postgres recusa a linha antes de qualquer código nosso rodar.

### 2.2 Mobile: Expo (React Native) + TypeScript

| Candidato | Avaliação |
|---|---|
| **Expo / React Native** | **Escolhido.** React 19 + TS já é a stack dos dois repositórios. `@supabase/supabase-js` roda idêntico em web e RN — o pacote `comm-client` é literalmente compartilhado. `expo-notifications` cobre APNs e FCM com uma API só. EAS Build resolve iOS sem Mac. |
| React Native puro | Mesmo ganho de reuso, mas configuração manual de push, build e atualização. Sem benefício sobre o Expo aqui. |
| Flutter | Stack nova (Dart). Zero reuso de código, de tipos ou de conhecimento. Duplicaria o modelo de dados em outra linguagem. |
| PWA | Descartado por causa da **emergência**. Push em iOS via PWA exige instalação manual na tela de início e não entrega em background com confiabilidade. Um canal de emergência que só funciona no Android não é um canal de emergência. |

**Reuso concreto:** `packages/comm-client` contém tipos, outbox offline, máquina
de estados da emergência e assinaturas de tempo real. O mesmo arquivo compila
para o Electron (paciente) e para o Expo (cuidador). Um único lugar onde a
semântica de entrega é definida.

### 2.3 O paciente não usa o app mobile

O paciente continua no IrisFlow desktop. O app mobile é **do cuidador**. Essa é
a leitura literal do §9 (*"NÃO criar uma interface convencional de smartphone
para o paciente"*) e evita a armadilha de fazer uma segunda interface acessível
que ninguém mantém.

---

## 3. Modelo de entidades

Aditivo. Prefixo `care_`/`comm_` para não colidir com o schema do site.
Nenhuma tabela existente é alterada, renomeada ou removida.

```
auth.users ──1:1── profiles                    (já existe — é a conta)
                      │
                      ├──< beneficiaries       (já existe — dado de saúde)
                      │         │
                      │         │ 0..1
                      │         ▼
                      └──< care_patients ──────────┐  (o paciente que se comunica)
                                   │               │
                                   │               ├──< care_patient_presence  (1:1)
                                   │               │
                        ┌──────────┴──────────┐    │
                        ▼                     ▼    │
                  care_links            care_link_invites
              (paciente ↔ cuidador,      (código de pareamento,
               N:N, com papel,            hash + expiração)
               permissões e status)
                        │
                        ▼
                 conversations ──< messages ──< message_receipts
                        │                          (por destinatário)
                        └──< emergency_alerts ──< emergency_alert_events
                                                     (auditoria append-only)

profiles ──< device_push_tokens          (um por dispositivo/plataforma)
         ──< notification_deliveries     (o que foi realmente despachado)
```

### 3.1 Por que `care_links` e não um `caregiver_id` em `care_patients`

O §6 pede explicitamente que a arquitetura não fique limitada a um cuidador.
`care_links` é uma tabela de junção com `role`
(`primary` | `secondary` | `professional`), `permissions jsonb` e `status`
(`pending` | `active` | `revoked`). Isso já comporta, sem migração destrutiva:

- vários cuidadores por paciente (e o **escalonamento** da emergência depende disso);
- um cuidador acompanhando vários pacientes;
- profissional de saúde ou clínica como papel distinto, com permissões menores;
- revogação de acesso preservando o histórico e a auditoria.

### 3.2 Por que `message_receipts` é uma tabela separada

Entrega e leitura são **por destinatário**, não por mensagem. Com dois
cuidadores vinculados, "lida" não é um booleano na mensagem: é lida pelo
cuidador A e não pelo B. Guardar `read_at` em `messages` obrigaria a reescrever
tudo assim que o segundo cuidador entrasse — e o §6 diz que isso vai acontecer.

### 3.3 Idempotência: `client_message_id`

Toda mensagem carrega um UUID gerado no cliente, com
`unique (conversation_id, client_message_id)`. O outbox pode reenviar à vontade
depois de um timeout, uma reconexão ou um restart do app: a segunda inserção
colide, o RPC devolve a linha já existente, e o usuário vê uma mensagem só.
É a defesa contra duplicata **e** contra replay de requisição (§23).

O mesmo vale para `client_alert_id` em `emergency_alerts`.

---

## 4. Fluxo de dados

### 4.1 Mensagem comum

```
Paciente (Electron)                Supabase                 Cuidador (Expo)
────────────────────               ────────                 ───────────────
seleciona frase pelo olhar
  │
  ├─ grava no outbox local (pending)
  │  UI: "enviando…"          ← nunca "enviado"
  │
  └─ rpc send_message(client_message_id, …)
                         ──────────►
                              insere em messages
                              (RLS valida o vínculo)
                                   │
                                   ├─ Realtime ──────────────► mensagem aparece
                                   │                            na conversa aberta
                                   │
                                   └─ webhook → push-fanout ──► notificação
                         ◄──────────
     devolve id + server_received_at
       │
       └─ outbox: pending → sent
          UI: "enviado ✓"          ← só agora
                                                        cuidador abre a conversa
                                   ◄──────────────────── rpc mark_delivered / mark_read
                              grava message_receipts
                                   │
                                   └─ Realtime ──► UI do paciente: "✓✓ lida"
```

### 4.2 Emergência

Sequência completa em `mobile-caregiver-implementation-plan.md`, Fase 8.
O ponto arquitetural: **o alarme local dispara antes e independentemente da
rede.** O que a rede muda é só o que a tela promete.

---

## 5. Contratos de API

O cliente nunca faz `insert` direto nas tabelas de escrita. Toda escrita passa
por uma função RPC `security definer` que valida o vínculo e normaliza o
remetente a partir de `auth.uid()`. Isso remove a classe inteira de ataques em
que o cliente forja `patient_id` ou `sender_id`.

Contratos completos em `api-contracts.md`. Resumo:

| Operação | Superfície |
|---|---|
| Login / sessão / logout / recuperação | Supabase Auth (SDK) |
| Listar conversas | `select` em `v_caregiver_conversations` (view, RLS) |
| Histórico de mensagens | `select` em `messages` (RLS) com paginação por `created_at` |
| Enviar mensagem | `rpc send_message(...)` |
| Marcar entregue / lida | `rpc mark_messages_delivered(...)` / `mark_messages_read(...)` |
| Disparar emergência | `rpc trigger_emergency(...)` |
| Cancelar emergência | `rpc cancel_emergency(...)` |
| Confirmar recebimento | `rpc acknowledge_emergency(...)` |
| Status do paciente | `select` em `care_patient_presence` (RLS) + heartbeat via `rpc touch_presence` |
| Criar convite de vínculo | `rpc create_link_invite(...)` |
| Aceitar convite | Edge Function `link-accept` (precisa de service role para resolver o hash) |
| Registrar token de push | `rpc register_push_token(...)` |

---

## 6. Autenticação

**Reutiliza o Supabase Auth do site.** Mesma tabela `auth.users`, mesma
`profiles`. Um cuidador que já comprou a IrisFlow entra no app com a mesma
credencial — sem segundo cadastro.

### 6.1 Cuidador (app mobile)

E-mail + senha via `supabase.auth.signInWithPassword`. Sessão persistida em
`expo-secure-store` (Keychain no iOS, Keystore no Android) — **não** em
`AsyncStorage`, que é texto puro no sandbox do app. Refresh automático pelo SDK.
Recuperação por `resetPasswordForEmail`.

### 6.2 Paciente (desktop)

O paciente **não digita senha**. Digitar credenciais pelo olhar é hostil e, em
recaída motora, impossível. O desktop usa um vínculo de dispositivo:

1. O cuidador (ou quem instalou) faz login uma vez no desktop, na área do
   cuidador, e escolhe o paciente.
2. O app troca essa sessão por uma sessão de longa duração armazenada no
   `safeStorage` do Electron (DPAPI no Windows / Keychain no macOS), fora do
   `localStorage`.
3. A partir daí o desktop opera como aquele paciente sem nova autenticação.
   O `refresh_token` renova sozinho.

Consequência honesta: quem tem acesso físico à máquina do paciente tem acesso à
conversa. Isso é aceitável e correto — é a máquina dele, na casa dele — e é o
mesmo modelo do WhatsApp Desktop. O que *não* é aceitável seria essa sessão
alcançar outros pacientes; a RLS garante que não alcança.

### 6.3 O que acontece com o PIN `1234`

`loginCaregiver(pin)` deixa de conceder acesso a dados remotos. Ele permanece
apenas como **trava local de tela** — impedir que o paciente entre sem querer na
área do cuidador pelo olhar. Autorização de rede passa a ser exclusivamente o
JWT do Supabase. O PIN nunca protegeu nada além da própria tela, e agora isso
está explícito em vez de implícito.

---

## 7. Tempo real

**Supabase Realtime**, um canal por conversa:

```ts
supabase.channel(`conversation:${conversationId}`)
  .on('postgres_changes', { event: 'INSERT', schema: 'public',
      table: 'messages', filter: `conversation_id=eq.${id}` }, onMessage)
  .on('postgres_changes', { event: '*', schema: 'public',
      table: 'emergency_alerts', filter: `patient_id=eq.${patientId}` }, onAlert)
  .subscribe()
```

O filtro do servidor é conveniência, **não** segurança: o Realtime respeita RLS,
então um cliente que assinasse a conversa de outro paciente não receberia linha
alguma.

**Reconexão.** O SDK reconecta com backoff sozinho, mas reconexão silenciosa
perde o intervalo em que esteve fora. Por isso `comm-client` faz, a cada
`SUBSCRIBED`, um *catch-up*: busca por `created_at > lastSeenAt` e concilia por
`client_message_id`. Sem isso, uma mensagem enviada durante uma troca de Wi-Fi
para 4G simplesmente não apareceria — e ninguém saberia.

**Presença.** `care_patient_presence` é atualizada por heartbeat a cada 60 s
enquanto o IrisFlow está aberto, com granularidade deliberadamente grosseira:
`online` / `offline` / `unknown`, `last_seen_at` e `irisflow_running`. Não há
tela vista, tempo de uso, nem localização — o §11 pede um canal de comunicação,
não vigilância.

---

## 8. Notificações

**Expo Push Service** (que fala com APNs e FCM), disparado por uma Edge Function
acionada por Database Webhook em `messages` e `emergency_alerts`.

Por urgência:

| Nível | Android | iOS | Som |
|---|---|---|---|
| `normal` | canal `mensagens`, prioridade default | passiva | padrão |
| `importante` | canal `mensagens`, prioridade high | ativa | padrão |
| `urgente` | canal `urgente`, prioridade max | time-sensitive | próprio |
| `emergencia` | canal `emergencia`, prioridade max, bypass DND | critical (requer entitlement da Apple) | próprio, contínuo |

`notification_deliveries` guarda o ticket do Expo e o resultado. Push que falha
é um fato registrado, não um silêncio.

**O que não é feito:** nenhuma notificação simulada, nenhum mock (§8). Sem
credencial de FCM/APNs configurada, o registro de token falha de forma visível e
o app diz que não vai receber alertas em segundo plano — em vez de fingir.

---

## 9. Emergência

Estados, exatamente os do §4 do briefing:

```
              (cliente)                         (servidor)
ENVIANDO ────────────────► ALERTA_DISPARADO ──► ENTREGUE ──► VISUALIZADO ──► CONFIRMADO
    │                            │                                                │
    │ retentativas               └──────────────► CANCELADO ◄──────────────────────┘
    │ esgotadas                                   (paciente cancela)
    ▼
FALHA_DE_ENVIO
```

- `ENVIANDO` é **local**. Existe antes de qualquer confirmação do servidor.
- `ALERTA_DISPARADO` é o primeiro estado que o servidor conhece: a linha existe,
  transacionada, com `triggered_at`.
- `ENTREGUE` só é gravado quando o **app do cuidador** confirma o recebimento —
  seja pelo Realtime, pelo handler de push ou pelo fetch de foreground. O ticket
  aceito pelo Expo **não** é entrega (§25.19).
- `VISUALIZADO` quando o alerta é aberto na tela.
- `CONFIRMADO` quando o cuidador toca em "Recebi, estou indo".
- `FALHA_DE_ENVIO` quando o cliente esgota as retentativas sem ack do servidor.

Cada transição grava uma linha em `emergency_alert_events` (append-only, com
autor e horário). É a trilha de auditoria do §12 e a única fonte que responde
"quando o cuidador soube?".

### 9.1 Camadas de fallback

Ordenadas da mais confiável para a menos:

1. **Alarme local no desktop** — som e voz, já implementados em
   `EmergencyContext`/`emergencyAudio`. Independe de rede, de servidor e de
   celular. É a única camada que funciona com a casa inteira sem internet, e é
   por isso que ela dispara **primeiro**.
2. **Persistência no servidor** (`ALERTA_DISPARADO`) — retentativa agressiva:
   backoff curto, sem teto de tentativas enquanto o alerta estiver ativo.
3. **Realtime** — chega instantaneamente se o app estiver aberto.
4. **Push de alta prioridade** — acorda o app fechado.
5. **Escalonamento por tempo** — se nenhum `acknowledged_at` em 60 s, a Edge
   Function `emergency-dispatch` reenvia para os cuidadores `secondary`.
6. **Ponte externa (SMS / voz)** — existe como *hook* documentado e **desligado
   por padrão** em `emergency-dispatch`. Não configurei provedor porque isso
   exigiria credenciais e uma decisão de custo que não é minha (§25.20).

### 9.2 O que a tela do paciente pode afirmar

| Situação | Texto |
|---|---|
| Antes do ack do servidor | *"Enviando alerta…"* |
| `ALERTA_DISPARADO` | *"Alerta registrado. Avisando seu cuidador."* |
| `ENTREGUE` | *"Seu cuidador recebeu o alerta."* |
| `VISUALIZADO` | *"Seu cuidador está vendo o alerta."* |
| `CONFIRMADO` | *"Seu cuidador confirmou. Está vindo."* |
| `FALHA_DE_ENVIO` | *"Não consegui avisar pela internet. O alarme sonoro está tocando."* |

A última linha é a mais importante do documento inteiro. Ela é a diferença entre
o sistema atual, que mente, e um sistema em que a pessoa sabe o que realmente
aconteceu.

---

## 10. Offline e conectividade

`packages/comm-client/src/outbox.ts` — fila persistida com:

- gravação **antes** do envio (nada se perde ao fechar o app);
- estados `pending` → `sending` → `sent` | `failed`;
- backoff exponencial com jitter (1 s → 32 s, teto), sem teto de tentativas para
  urgência `emergencia`;
- deduplicação por `client_message_id` (o servidor é a segunda barreira);
- ordenação FIFO por conversa, para não embaralhar o diálogo;
- `StorageAdapter` injetável: `localStorage` no Electron, `AsyncStorage` no Expo,
  `Map` nos testes.

Regra que o outbox impõe à interface: `sent` só existe com resposta do servidor.

---

## 11. Privacidade e segurança

### 11.1 O que nunca sai do dispositivo do paciente

Frames da webcam, imagens, landmarks faciais, vetores de calibração, saída do
L2CS, homografia, parâmetros de filtro. O `comm-client` não tem acesso ao módulo
de rastreamento; a fronteira é estrutural, não uma convenção. O §12 e o §17 são
respeitados por construção: a nova camada não importa nada de `src/tracker`,
`src/l2cs` ou `src/calibration`.

O que trafega: texto da mensagem, categoria, urgência, horários, ids.

### 11.2 Superfícies de ataque tratadas (§23)

| Vetor | Defesa |
|---|---|
| IDOR em conversa/mensagem | RLS via `public.has_patient_access(patient_id)`; sem vínculo `active`, o `select` devolve zero linhas |
| Forjar `patient_id` | Cliente não envia `patient_id` em escrita; o RPC deriva da conversa e revalida |
| Forjar `caregiver_id` / remetente | `sender_user_id` vem sempre de `auth.uid()` dentro do RPC |
| Acesso a paciente não vinculado | Mesma função de acesso em toda policy; `revoked` derruba na hora |
| Replay de requisição | `unique (conversation_id, client_message_id)` e `unique (patient_id, client_alert_id)` |
| Token inválido / sessão expirada | JWT verificado pelo PostgREST antes da policy; refresh no SDK; `signOut` limpa o secure store |
| Abuso do endpoint de emergência | Janela de deduplicação de 30 s por paciente dentro de `trigger_emergency`: reacionar devolve o alerta ativo em vez de criar outro |
| Spam de mensagens | Rate limit por paciente em `send_message` (60/min), erro explícito. **`emergencia` nunca é limitada.** |
| Enumeração de usuários | Convite por código de uso único com hash SHA-256, expiração de 24 h e resposta uniforme; não existe endpoint que aceite e-mail e responda "existe" |
| Exposição de dados pessoais | O app do cuidador nunca lê `beneficiaries`; `care_patients` expõe só `display_name` |

### 11.3 Criptografia, retenção e auditoria

- **Em trânsito:** TLS 1.2+ obrigatório (Supabase). Nenhum endpoint em texto claro.
- **Em repouso:** AES-256 no volume gerenciado. Sem criptografia ponta a ponta —
  e isso é uma escolha declarada: E2EE quebraria a busca no histórico, o push
  com prévia e a recuperação de conta, e o modelo de ameaça aqui (evitar acesso
  cruzado entre pacientes) é resolvido pela RLS. Se E2EE virar requisito, o
  lugar é `messages.body`, e o resto do schema não muda.
- **Retenção:** mensagens 12 meses (`purge_old_messages()`); alertas e eventos de
  auditoria **nunca** são apagados automaticamente — são registro de segurança.
- **Exclusão:** o titular apaga a própria mensagem (`soft delete`, `deleted_at`);
  o corpo é zerado, a linha permanece para a integridade do fio.
- **Logs:** `emergency_alert_events` e `notification_deliveries` guardam ids e
  horários, nunca o conteúdo da mensagem.

---

## 12. Impacto no produto existente

| Arquivo do Blinkv1 | Mudança |
|---|---|
| `src/tracker`, `src/l2cs`, `src/calibration`, `src/filters`, `src/pose`, `src/preprocess`, `src/capture` | **Nenhuma.** |
| `frontend/src/context/GazeContext.tsx` | **Nenhuma.** |
| `frontend/src/context/AuthContext.tsx` | Ganha sessão Supabase opcional; `mockProfiles` e `loginCaregiver` continuam funcionando sem configuração |
| `frontend/src/App.tsx` | 2 rotas novas (`/caregiver-chat`, `/caregiver-chat/history`) e 1 provider |
| `frontend/src/pages/MainMenu.tsx` | 1 item novo: "Falar com cuidador" |
| `frontend/src/pages/output/EmergencyEscalation.tsx` | Passa a refletir o estado real do alerta em vez de afirmar entrega |
| `frontend/src/utils/api.ts` | Intocado — segue existindo para voz e chatbot |

Sem configuração de Supabase o app se comporta **exatamente como hoje**: a
funcionalidade se desativa sozinha e nenhuma tela quebra. Isso é verificado por
teste.

---

## 13. Riscos técnicos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Push crítico no iOS exige entitlement especial da Apple, com aprovação demorada | Time-sensitive (sem entitlement) já entrega. O código detecta e degrada. Documentado, não escondido. |
| R2 | Android mata processos em segundo plano de forma agressiva (Xiaomi, Huawei) | Canal de notificação dedicado com bypass de DND + tela de onboarding que pede isenção de otimização de bateria |
| R3 | Casa do paciente sem internet | Camada 1 (alarme local) é a resposta. A UI diz a verdade sobre a rede. |
| R4 | Expo Push é um terceiro no caminho da emergência | `notification_deliveries` registra cada ticket; o `ENTREGUE` depende do app, não do ticket; escalonamento cobre a falha |
| R5 | Realtime do Supabase tem teto de conexões simultâneas por plano | Um canal por conversa aberta, fechado ao sair da tela. Push cobre o app fechado. |
| R6 | RLS mal escrita vaza dados entre pacientes | Suíte dedicada em `supabase/tests/rls.sql` com o caso negativo explícito |
| R7 | `beneficiaries` tem 1 linha e nenhum `care_patients` ainda | Migração de dados opcional e idempotente em `0005_seed_vinculo.sql`, para o operador rodar conscientemente |
| R8 | O desktop não tem servidor hoje; o operador precisa preencher `.env` | Sem `.env`, funcionalidade desligada e visível. Nunca meio-ligada. |
