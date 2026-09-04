-- =====================================================================
-- IrisFlow — Comunicação Paciente <-> Cuidador
-- Migração 0001: tipos e tabelas
--
-- ADITIVA. Não altera, renomeia nem remove nada do schema existente
-- (profiles, beneficiaries, subscriptions, plans, payment_methods,
-- charges, contact_messages, app_releases).
--
-- IDEMPOTENTE. Rodar de novo não quebra e não duplica.
--
-- Depende de: public.profiles (id uuid -> auth.users), public.beneficiaries.
-- =====================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid(), digest()


-- ---------------------------------------------------------------------
-- 1. Tipos
--
-- Enum e não texto com CHECK: um valor novo aqui é um ALTER TYPE, que o
-- Postgres registra; um CHECK vira string solta espalhada pelo código.
-- Para acrescentar depois:  alter type public.urgency_t add value 'x';
-- ---------------------------------------------------------------------

do $$ begin
  create type public.care_role_t as enum ('primary', 'secondary', 'professional');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.care_link_status_t as enum ('pending', 'active', 'revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  -- 'system' cobre mensagens geradas pela própria IrisFlow (ex.: "cheguei ao
  -- fim da calibração"), previstas no §2 do briefing.
  create type public.message_kind_t as enum
    ('text', 'quick_phrase', 'yes', 'no', 'request', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Os quatro níveis do §5, nos termos do próprio briefing.
  create type public.urgency_t as enum
    ('normal', 'importante', 'urgente', 'emergencia');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sender_kind_t as enum ('patient', 'caregiver', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Os sete estados do §4. 'ENVIANDO' é deliberadamente ausente: ele é um
  -- estado do CLIENTE, anterior a qualquer linha no banco. Se existisse aqui,
  -- seria uma contradição — a linha existir já significa que o servidor
  -- recebeu.
  create type public.emergency_state_t as enum
    ('ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO',
     'CONFIRMADO', 'CANCELADO', 'FALHA_DE_ENVIO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.push_platform_t as enum ('ios', 'android', 'web');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
-- 2. care_patients — o paciente enquanto participante da comunicação
--
-- Separado de `beneficiaries` de propósito. `beneficiaries` guarda dado
-- sensível de saúde (a própria tabela diz isso no comentário dela: LGPD
-- art. 5º, II). O app do cuidador precisa de nome e id para conversar, e
-- não precisa saber a condição clínica. Duas tabelas = a RLS consegue
-- liberar uma sem liberar a outra.
--
-- `beneficiary_id` é opcional: dá para operar o canal de comunicação sem
-- ter passado pelo fluxo de compra do site.
-- ---------------------------------------------------------------------
create table if not exists public.care_patients (
  id              uuid primary key default gen_random_uuid(),
  beneficiary_id  uuid references public.beneficiaries (id) on delete set null,
  -- Conta própria do paciente, quando existe. Nula é o caso comum: o
  -- desktop autentica por sessão de dispositivo, não por login do paciente.
  user_id         uuid unique references auth.users (id) on delete set null,
  -- Quem administra o cadastro (normalmente o cuidador principal / comprador).
  owner_user_id   uuid not null references auth.users (id) on delete cascade,
  display_name    text not null check (length(btrim(display_name)) between 1 and 80),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.care_patients is
  'Paciente enquanto participante do canal de comunicação. Sem dado clínico — '
  'esse fica em beneficiaries, com controle de acesso próprio.';

create index if not exists care_patients_owner_idx
  on public.care_patients (owner_user_id);


-- ---------------------------------------------------------------------
-- 3. care_links — vínculo paciente <-> cuidador (N:N)
--
-- É aqui que o §6 do briefing vira estrutura. Tabela de junção, não coluna
-- em care_patients: um paciente pode ter cuidador principal + secundário +
-- fisioterapeuta, e o escalonamento da emergência DEPENDE de existir mais
-- de um.
--
-- `permissions` como jsonb permite restringir um profissional (por exemplo,
-- {"read": true, "write": false, "emergency": true}) sem migração.
-- ---------------------------------------------------------------------
create table if not exists public.care_links (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.care_patients (id) on delete cascade,
  caregiver_user_id  uuid not null references auth.users (id) on delete cascade,
  role               public.care_role_t not null default 'primary',
  status             public.care_link_status_t not null default 'active',
  permissions        jsonb not null default
                       '{"read": true, "write": true, "emergency": true}'::jsonb,
  -- Ordem de escalonamento da emergência. 0 = avisado primeiro.
  escalation_order   smallint not null default 0 check (escalation_order between 0 and 99),
  created_at         timestamptz not null default now(),
  accepted_at        timestamptz,
  revoked_at         timestamptz,
  unique (patient_id, caregiver_user_id)
);

comment on table public.care_links is
  'Vínculo N:N. Revogar = status revoked, nunca delete: o histórico e a '
  'auditoria precisam continuar apontando para um vínculo que existiu.';

create index if not exists care_links_caregiver_idx
  on public.care_links (caregiver_user_id) where status = 'active';
create index if not exists care_links_patient_idx
  on public.care_links (patient_id) where status = 'active';


-- ---------------------------------------------------------------------
-- 4. care_link_invites — pareamento por código de uso único
--
-- Por que não convidar por e-mail: um endpoint que aceita e-mail e responde
-- "enviado" / "não existe" é um oráculo de enumeração de usuários (§23).
-- O código não revela nada sobre quem já tem conta.
--
-- Guardamos apenas o SHA-256. Um vazamento do banco não entrega códigos
-- utilizáveis, e mesmo assim eles expiram em 24 h.
-- ---------------------------------------------------------------------
create table if not exists public.care_link_invites (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.care_patients (id) on delete cascade,
  code_hash      text not null unique,
  role           public.care_role_t not null default 'secondary',
  created_by     uuid not null references auth.users (id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_by        uuid references auth.users (id) on delete set null,
  check (expires_at > created_at)
);

create index if not exists care_link_invites_patient_idx
  on public.care_link_invites (patient_id);


-- ---------------------------------------------------------------------
-- 5. conversations — um fio por par (paciente, cuidador)
--
-- Não é um fio por paciente. Com dois cuidadores, "a conversa" de cada um é
-- diferente: o que o cuidador A escreveu não é necessariamente assunto do B.
-- Mensagens do paciente são replicadas para cada fio pelo RPC de broadcast.
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.care_patients (id) on delete cascade,
  caregiver_user_id  uuid not null references auth.users (id) on delete cascade,
  created_at         timestamptz not null default now(),
  last_message_at    timestamptz,
  unique (patient_id, caregiver_user_id)
);

create index if not exists conversations_caregiver_recent_idx
  on public.conversations (caregiver_user_id, last_message_at desc nulls last);


-- ---------------------------------------------------------------------
-- 6. messages
--
-- `client_message_id` é a peça central da confiabilidade. Gerado no
-- dispositivo ANTES do envio, ele torna o reenvio seguro: o outbox pode
-- tentar quantas vezes quiser depois de um timeout ou de um restart, que a
-- unique constraint garante uma linha só. Sem isso, toda reconexão
-- duplicaria mensagem — e "Preciso de ajuda" aparecendo três vezes faz o
-- cuidador achar que são três pedidos.
--
-- Também é a defesa contra replay: reenviar a mesma requisição capturada não
-- produz uma segunda mensagem.
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.conversations (id) on delete cascade,
  client_message_id  uuid not null,
  sender_kind        public.sender_kind_t not null,
  -- Nulo quando o remetente é o paciente sem conta própria (caso comum) ou
  -- o sistema. Nunca vem do cliente: o RPC preenche com auth.uid().
  sender_user_id     uuid references auth.users (id) on delete set null,
  kind               public.message_kind_t not null default 'text',
  urgency            public.urgency_t not null default 'normal',
  body               text not null check (length(body) between 1 and 2000),
  created_at         timestamptz not null default now(),
  -- Horário do servidor. É este que a UI exibe: o relógio do cliente pode
  -- estar errado, e num histórico clínico ordem invertida é um problema real.
  server_received_at timestamptz not null default now(),
  -- Soft delete: zera o corpo, preserva a linha. Apagar a linha abriria
  -- buraco no fio e na auditoria.
  deleted_at         timestamptz,
  unique (conversation_id, client_message_id)
);

comment on column public.messages.client_message_id is
  'UUID gerado no cliente antes do envio. Torna o reenvio idempotente e '
  'bloqueia replay. É o que permite ao outbox retentar sem duplicar.';

create index if not exists messages_conversation_time_idx
  on public.messages (conversation_id, created_at desc);
create index if not exists messages_urgency_idx
  on public.messages (conversation_id, created_at desc)
  where urgency in ('urgente', 'emergencia');


-- ---------------------------------------------------------------------
-- 7. message_receipts — entrega e leitura POR DESTINATÁRIO
--
-- Colunas delivered_at/read_at em `messages` seriam mais simples e estariam
-- erradas: com dois cuidadores, "lida" não é um booleano. O §6 diz que o
-- segundo cuidador vai existir, então a forma certa já é esta.
-- ---------------------------------------------------------------------
create table if not exists public.message_receipts (
  message_id          uuid not null references public.messages (id) on delete cascade,
  recipient_user_id   uuid not null references auth.users (id) on delete cascade,
  delivered_at        timestamptz,
  read_at             timestamptz,
  primary key (message_id, recipient_user_id)
);

create index if not exists message_receipts_recipient_idx
  on public.message_receipts (recipient_user_id) where read_at is null;


-- ---------------------------------------------------------------------
-- 8. emergency_alerts
--
-- Tabela própria, não uma mensagem com urgency='emergencia'. Motivo: um
-- alerta tem ciclo de vida (disparado -> entregue -> visualizado ->
-- confirmado), tem quem confirmou, tem escalonamento e tem retenção
-- diferente. Enfiar isso em `messages` misturaria duas coisas com regras
-- distintas.
--
-- `client_alert_id` faz pelo alerta o que client_message_id faz pela
-- mensagem. Aqui importa ainda mais: retentativa agressiva é justamente a
-- estratégia da emergência, então duplicar seria a regra e não a exceção.
-- ---------------------------------------------------------------------
create table if not exists public.emergency_alerts (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.care_patients (id) on delete cascade,
  client_alert_id  uuid not null,
  category         text not null default 'other'
                     check (category in ('pain', 'breath', 'cold', 'other')),
  state            public.emergency_state_t not null default 'ALERTA_DISPARADO',
  note             text check (note is null or length(note) <= 500),

  triggered_at     timestamptz not null default now(),
  delivered_at     timestamptz,   -- app do cuidador confirmou (NÃO o ticket de push)
  seen_at          timestamptz,   -- alerta aberto na tela
  acknowledged_at  timestamptz,   -- "RECEBI, ESTOU INDO"
  acknowledged_by  uuid references auth.users (id) on delete set null,
  cancelled_at     timestamptz,
  failed_at        timestamptz,
  failure_reason   text,

  escalated_at     timestamptz,
  escalation_level smallint not null default 0,

  unique (patient_id, client_alert_id)
);

comment on column public.emergency_alerts.delivered_at is
  'Gravado quando o APP do cuidador confirma o recebimento — nunca quando o '
  'serviço de push aceita o ticket. Push aceito não é push entregue (§25.19).';

-- Índice parcial: "existe alerta ativo para este paciente?" é consultado a
-- cada disparo, e a tabela cresce para sempre (alertas não são purgados).
create index if not exists emergency_alerts_active_idx
  on public.emergency_alerts (patient_id, triggered_at desc)
  where state in ('ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO');

-- Usado pelo cron do escalonamento.
create index if not exists emergency_alerts_pending_ack_idx
  on public.emergency_alerts (triggered_at)
  where state in ('ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO');


-- ---------------------------------------------------------------------
-- 9. emergency_alert_events — auditoria append-only
--
-- Sem update, sem delete (garantido pela RLS na 0002). É a única fonte capaz
-- de responder "quando exatamente o cuidador soube?", que é a pergunta que
-- um dia alguém vai fazer a sério.
-- ---------------------------------------------------------------------
create table if not exists public.emergency_alert_events (
  id          bigserial primary key,
  alert_id    uuid not null references public.emergency_alerts (id) on delete cascade,
  state       public.emergency_state_t not null,
  actor_id    uuid references auth.users (id) on delete set null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists emergency_alert_events_alert_idx
  on public.emergency_alert_events (alert_id, created_at);


-- ---------------------------------------------------------------------
-- 10. care_patient_presence
--
-- Deliberadamente grosseiro. O §11 pede status, e no mesmo parágrafo proíbe
-- transformar o produto em vigilância. Então: online/offline, último
-- heartbeat, e se o IrisFlow está aberto. Não guardamos tela visitada, tempo
-- de uso, nem qualquer coisa que responda "o que ele está fazendo agora".
-- ---------------------------------------------------------------------
create table if not exists public.care_patient_presence (
  patient_id        uuid primary key references public.care_patients (id) on delete cascade,
  status            text not null default 'unknown'
                      check (status in ('online', 'offline', 'unknown')),
  irisflow_running  boolean not null default false,
  last_seen_at      timestamptz,
  last_message_at   timestamptz,
  last_alert_at     timestamptz,
  updated_at        timestamptz not null default now()
);

comment on table public.care_patient_presence is
  'Granularidade grosseira de propósito (§11): comunicação e segurança, não '
  'monitoramento. Nada aqui responde "o que o paciente está fazendo".';


-- ---------------------------------------------------------------------
-- 11. device_push_tokens
-- ---------------------------------------------------------------------
create table if not exists public.device_push_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  token         text not null unique,
  platform      public.push_platform_t not null,
  device_label  text,
  -- Sinaliza se o dispositivo tem o entitlement de alerta crítico do iOS.
  -- Sem ele o app usa time-sensitive e DIZ isso na tela, em vez de deixar o
  -- cuidador supor que vai ser acordado.
  critical_ok   boolean not null default false,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Preenchido quando o Expo devolve DeviceNotRegistered.
  disabled_at   timestamptz
);

create index if not exists device_push_tokens_user_idx
  on public.device_push_tokens (user_id) where disabled_at is null;


-- ---------------------------------------------------------------------
-- 12. notification_deliveries
--
-- Guarda ids e resultado, NUNCA o corpo da mensagem (§12: logs não devem
-- conter conteúdo). Existe para que "o push falhou" seja um fato consultável
-- e não um silêncio.
-- ---------------------------------------------------------------------
create table if not exists public.notification_deliveries (
  id            bigserial primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  token_id      uuid references public.device_push_tokens (id) on delete set null,
  message_id    uuid references public.messages (id) on delete cascade,
  alert_id      uuid references public.emergency_alerts (id) on delete cascade,
  urgency       public.urgency_t not null default 'normal',
  provider      text not null default 'expo',
  ticket_id     text,
  status        text not null default 'queued'
                  check (status in ('queued', 'accepted', 'error')),
  error_code    text,
  created_at    timestamptz not null default now(),
  -- Ou é sobre uma mensagem, ou sobre um alerta. Nunca os dois, nunca nenhum.
  check (num_nonnulls(message_id, alert_id) = 1)
);

create index if not exists notification_deliveries_alert_idx
  on public.notification_deliveries (alert_id) where alert_id is not null;


-- ---------------------------------------------------------------------
-- 13. updated_at automático
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists care_patients_touch on public.care_patients;
create trigger care_patients_touch
  before update on public.care_patients
  for each row execute function public.touch_updated_at();

drop trigger if exists care_patient_presence_touch on public.care_patient_presence;
create trigger care_patient_presence_touch
  before update on public.care_patient_presence
  for each row execute function public.touch_updated_at();
