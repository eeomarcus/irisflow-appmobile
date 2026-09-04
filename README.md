# IrisFlow — Comunicação Paciente ↔ Cuidador

Canal de comunicação bidirecional entre quem usa o IrisFlow pelo olhar e quem
cuida dessa pessoa. App mobile para o cuidador, nova área no desktop para o
paciente, e a camada de servidor que liga os dois.

Extensão do produto existente, não substituição: o rastreamento ocular, a
calibração e o pipeline de visão computacional não são tocados.

```
┌──────────────────────┐        ┌──────────────────────┐       ┌──────────────────┐
│  IRISFLOW DESKTOP    │        │       SUPABASE       │       │   APP MOBILE     │
│      PACIENTE        │        │  Auth · Postgres+RLS │       │    CUIDADOR      │
│                      │───────►│  Realtime · Edge Fn  │──────►│                  │
│  "Falar com cuidador"│  msg   │                      │ push  │  conversa        │
│  Emergência (olhar)  │  SOS   │  autorização no BANCO│ tempo │  🚨 emergência   │
│                      │◄───────│                      │◄──────│  confirmar       │
└──────────────────────┘        └──────────────────────┘       └──────────────────┘
```

---

## O que tem aqui

```
docs/
  mobile-caregiver-architecture.md        auditoria, decisões e por quês
  mobile-caregiver-implementation-plan.md 12 fases, o que está pronto e o que depende de você
  api-contracts.md                        contratos completos (RPC, tabelas, Edge Functions)
  integracao-desktop.md                   passo a passo para o Blinkv1

supabase/
  migrations/  0001 tabelas · 0002 RLS · 0003 RPC · 0004 realtime e views
  functions/   link-accept · push-fanout · emergency-dispatch
  tests/       rls.sql — testes de isolamento entre pacientes

packages/comm-client/    biblioteca compartilhada (desktop + mobile), 90 testes
apps/caregiver-app/      app do cuidador (Expo + TypeScript)
desktop-integration/     arquivos para copiar no Blinkv1
```

---

## Três decisões, em uma linha cada

**Reutilizar o Supabase que a IrisFlow já opera.** Ele entrega auth, banco,
tempo real e funções sem infraestrutura nova. Criar um backend paralelo seria
a segunda arquitetura desnecessária que o briefing proíbe.

**Autorização mora no Postgres, não no app.** Toda policy passa por
`has_patient_access()`. Um bug no app mobile não consegue vazar a conversa de
outro paciente, porque o banco recusa a linha antes de qualquer código nosso
rodar.

**Expo para o mobile.** React + TypeScript já é a stack dos dois repositórios,
o `comm-client` é literalmente o mesmo arquivo nos dois lados, e
`expo-notifications` cobre APNs e FCM com uma API só. PWA foi descartado por
causa da emergência: push em iOS via PWA não é confiável em background, e um
canal de emergência que só funciona no Android não é um canal de emergência.

---

## O defeito que esta entrega conserta

`Blinkv1/frontend/src/pages/output/EmergencyEscalation.tsx`, hoje:

```ts
api.sendHelpAlert(...).catch((e) => console.warn(...));   // engole a falha
```

e a tela mostra, sem condição:

> *"Seu alerta foi enviado. Aguarde atendimento."*

`env.apiUrl` aponta para `http://localhost:8000/api`, e não existe servidor
algum no repositório. **Essa frase é falsa em 100% dos casos hoje.**

Para alguém com ELA sozinho em casa, a diferença entre "o socorro foi
chamado" e "ninguém foi avisado" é a diferença que o produto inteiro existe
para cobrir. Agora a tela mostra o estado real:

| Situação | Texto |
|---|---|
| antes do ack do servidor | *"Enviando alerta…"* |
| `ALERTA_DISPARADO` | *"Alerta registrado. Estamos avisando seu cuidador."* |
| `ENTREGUE` | *"Seu cuidador recebeu o alerta."* |
| `CONFIRMADO` | *"Seu cuidador confirmou. Está vindo."* |
| `FALHA_DE_ENVIO` | *"Não consegui avisar pela internet. O alarme sonoro continua tocando."* |

A última linha é a razão de existir de metade do código deste repositório.

---

## Como colocar de pé

### 1. Banco

```bash
supabase link --project-ref ydnsnbeugxzhpkpqpqhb
supabase db push          # ou cole 0001..0004 no SQL Editor, nessa ordem
```

Migrações **aditivas**: nenhuma tabela existente é alterada, renomeada ou
removida. Idempotentes: rodar duas vezes não quebra.

Confira o isolamento entre pacientes antes de seguir:

```bash
# cole supabase/tests/rls.sql no SQL Editor de um projeto de desenvolvimento
```

### 2. Funções e automações

```bash
supabase functions deploy link-accept push-fanout emergency-dispatch
supabase secrets set EXPO_ACCESS_TOKEN=... WEBHOOK_SECRET=... CRON_SECRET=...
```

No painel, em **Database › Webhooks**:

| Tabela | Evento | Destino | Header |
|---|---|---|---|
| `messages` | INSERT | `push-fanout` | `x-webhook-secret` |
| `emergency_alerts` | INSERT | `push-fanout` | `x-webhook-secret` |

Em **Database › Cron**: `emergency-dispatch` a cada minuto.

### 3. Biblioteca compartilhada

```bash
cd packages/comm-client && npm install && npm test
```

### 4. App do cuidador

```bash
cd apps/caregiver-app
npm install
cp .env.example .env      # preencha a chave anônima
npx expo start
```

#### Ver as telas sem backend (pré-visualização)

Para avaliar a interface antes de provisionar qualquer coisa:

```bash
cd apps/caregiver-app
npm install
echo EXPO_PUBLIC_PREVIEW=1 > .env
npm run web               # abre em http://localhost:8081
```

Uma tarja preta e amarela fica fixa no topo enquanto o modo estiver ligado, e
o botão **"Ver emergência"** dispara o alerta de exemplo — a tela que mais
importa e a única que não dá para alcançar navegando.

O que a troca faz: `src/lib/supabase.ts` substitui o cliente Supabase por uma
implementação em memória (`src/preview/`). **As telas não têm uma linha
diferente.** Se eu tivesse feito telas de demonstração separadas, a
demonstração poderia estar certa e o produto errado.

Três travas, porque o §25.8 diz que mock não é solução final:

- só liga com `EXPO_PUBLIC_PREVIEW=1`;
- `assertPreviewSafe()` lança em build de produção;
- push **não** é simulado (§8) — a tela de status mostra o aviso real de que
  as notificações não estão funcionando, em vez de fingir que estão.

Para desligar, apague a linha do `.env`.

> O navegador aproxima, não substitui. Vibração, canais de notificação do
> Android e o comportamento em tela bloqueada só aparecem em aparelho físico.

Para push de verdade: `eas init`, credenciais de FCM (Android) e APNs (iOS).
Sem isso o app **diz na tela** que não vai receber alertas em segundo plano,
em vez de fingir que vai.

### 5. Desktop

Siga `docs/integracao-desktop.md`. Sem `.env.local` o IrisFlow se comporta
exatamente como hoje — a funcionalidade se desativa sozinha.

---

## O que está pronto e o que depende de você

**Pronto:** schema e RLS, todos os RPCs, as três Edge Functions,
`comm-client` com outbox offline e máquina de estados da emergência (90
testes), app do cuidador com cinco telas, arquivos de integração do desktop,
testes de RLS, documentação.

**Depende das suas contas** (não posso fazer por você):

- conta Expo/EAS e `eas init`;
- chave FCM v1 no projeto Android e chave APNs no Apple Developer;
- o entitlement de **alerta crítico** do iOS, que a Apple concede caso a caso
  — sem ele o app usa *time-sensitive*, que já fura o modo Foco, e avisa o
  cuidador que o nível crítico não está ativo;
- deploy das migrações e das funções no projeto de produção;
- publicação nas lojas;
- teste em aparelho físico e teste de invasão.

**Deliberadamente não feito:** a ponte externa de SMS/voz do escalonamento
existe como *hook* documentado e desligado em `emergency-dispatch`. Escolher
provedor exigiria credenciais, cadastro regulatório e uma decisão de custo
recorrente que é do produto, não minha.

---

## Segurança, em resumo

| Vetor | Defesa |
|---|---|
| IDOR / acesso a paciente não vinculado | RLS via `has_patient_access()`; sem vínculo `active`, zero linhas |
| Forjar `patient_id` / `caregiver_id` | Escrita só por RPC; identidade sempre de `auth.uid()` |
| Replay e mensagens duplicadas | `unique (conversation_id, client_message_id)` e `(patient_id, client_alert_id)` |
| Abuso do endpoint de emergência | Janela de dedupe de 30 s; converge para o alerta ativo em vez de recusar |
| Spam | 60 msg/min por conversa. `emergencia` **nunca** é limitada |
| Enumeração de usuários | Código de uso único com hash, resposta uniforme e atraso constante |
| Vazamento de dados de visão computacional | `comm-client` não importa nada do pipeline de rastreamento — fronteira estrutural |
| Auditoria adulterada | `emergency_alert_events` é append-only, sem UPDATE nem DELETE |

Detalhes e o modelo de ameaça completo em
`docs/mobile-caregiver-architecture.md`, seção 11.
#   i r i s f l o w - a p p m o b i l e  
 