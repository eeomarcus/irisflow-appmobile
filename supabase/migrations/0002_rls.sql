-- =====================================================================
-- IrisFlow — Comunicação Paciente <-> Cuidador
-- Migração 0002: Row Level Security
--
-- Esta é a camada de autorização do produto. Não há checagem equivalente na
-- aplicação, e isso é intencional: autorização escrita à mão no cliente é
-- onde IDOR nasce. Aqui, um bug no app mobile não consegue ler a conversa de
-- outro paciente, porque o Postgres recusa a linha antes de qualquer código
-- nosso rodar.
--
-- Regra de leitura deste arquivo: TODA policy passa por
-- public.has_patient_access(). Se alguma não passar, é bug.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. A função de acesso
--
-- SECURITY DEFINER porque precisa ler care_links ignorando a RLS de
-- care_links — senão a policy de care_links dependeria dela mesma e o
-- Postgres entraria em recursão infinita.
--
-- STABLE + search_path fixo: sem o search_path explícito, uma função
-- security definer é sequestrável por um schema plantado pelo chamador.
-- ---------------------------------------------------------------------
create or replace function public.has_patient_access(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    -- Cuidador com vínculo ATIVO. 'pending' e 'revoked' não dão acesso:
    -- revogar precisa cortar na hora, sem esperar sessão expirar.
    select 1
      from public.care_links l
     where l.patient_id = p_patient_id
       and l.caregiver_user_id = auth.uid()
       and l.status = 'active'
  ) or exists (
    -- Quem administra o cadastro do paciente, ou o próprio paciente quando
    -- ele tem conta.
    select 1
      from public.care_patients p
     where p.id = p_patient_id
       and (p.owner_user_id = auth.uid() or p.user_id = auth.uid())
  );
$$;

comment on function public.has_patient_access(uuid) is
  'Única porta de autorização do canal de comunicação. Toda policy passa por '
  'aqui. Vínculo precisa estar active: revogação corta acesso imediatamente.';


-- Permissão de ESCRITA. Separada da leitura porque um profissional de saúde
-- pode ter leitura sem escrita — o jsonb permissions em care_links.
create or replace function public.can_write_to_patient(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.care_links l
     where l.patient_id = p_patient_id
       and l.caregiver_user_id = auth.uid()
       and l.status = 'active'
       and coalesce((l.permissions ->> 'write')::boolean, false)
  ) or exists (
    select 1
      from public.care_patients p
     where p.id = p_patient_id
       and (p.owner_user_id = auth.uid() or p.user_id = auth.uid())
  );
$$;


-- Acesso via conversa, que é o caminho que messages e receipts usam.
create or replace function public.has_conversation_access(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.conversations c
     where c.id = p_conversation_id
       and public.has_patient_access(c.patient_id)
  );
$$;


-- ---------------------------------------------------------------------
-- 2. Habilitar RLS
--
-- Sem policy + RLS ligada = ninguém lê nada. É o padrão certo: o acesso é
-- concedido explicitamente abaixo, e uma tabela que eu esquecesse de cobrir
-- ficaria fechada em vez de aberta.
-- ---------------------------------------------------------------------
alter table public.care_patients            enable row level security;
alter table public.care_links               enable row level security;
alter table public.care_link_invites        enable row level security;
alter table public.conversations            enable row level security;
alter table public.messages                 enable row level security;
alter table public.message_receipts         enable row level security;
alter table public.emergency_alerts         enable row level security;
alter table public.emergency_alert_events   enable row level security;
alter table public.care_patient_presence    enable row level security;
alter table public.device_push_tokens       enable row level security;
alter table public.notification_deliveries  enable row level security;

-- Força a RLS até para o dono das tabelas. Sem isso, um job rodando como
-- postgres passa por cima de tudo sem perceber.
alter table public.messages                 force row level security;
alter table public.emergency_alerts         force row level security;
alter table public.emergency_alert_events   force row level security;


-- ---------------------------------------------------------------------
-- 3. care_patients
-- ---------------------------------------------------------------------
drop policy if exists care_patients_select on public.care_patients;
create policy care_patients_select on public.care_patients
  for select to authenticated
  using (public.has_patient_access(id));

drop policy if exists care_patients_insert on public.care_patients;
create policy care_patients_insert on public.care_patients
  for insert to authenticated
  -- Só dá para criar paciente em nome de si mesmo. Sem isso, alguém criaria
  -- um paciente com owner_user_id de outra pessoa.
  with check (owner_user_id = auth.uid());

drop policy if exists care_patients_update on public.care_patients;
create policy care_patients_update on public.care_patients
  for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- Sem policy de DELETE: paciente não é apagado pelo app. Exclusão de titular
-- é procedimento administrativo, com auditoria.


-- ---------------------------------------------------------------------
-- 4. care_links
-- ---------------------------------------------------------------------
drop policy if exists care_links_select on public.care_links;
create policy care_links_select on public.care_links
  for select to authenticated
  using (
    caregiver_user_id = auth.uid()
    or exists (select 1 from public.care_patients p
                where p.id = care_links.patient_id
                  and p.owner_user_id = auth.uid())
  );

-- INSERT não é permitido pelo cliente em nenhuma hipótese. Vínculo nasce
-- apenas por RPC (create_link_invite) ou pela Edge Function link-accept,
-- que valida o código. Se o cliente pudesse inserir aqui, bastaria um
-- insert com o patient_id alheio para ganhar acesso à conversa — é
-- exatamente o "alteração de patient_id" do §23.

drop policy if exists care_links_update_owner on public.care_links;
create policy care_links_update_owner on public.care_links
  for update to authenticated
  using (exists (select 1 from public.care_patients p
                  where p.id = care_links.patient_id
                    and p.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.care_patients p
                       where p.id = care_links.patient_id
                         and p.owner_user_id = auth.uid()));


-- ---------------------------------------------------------------------
-- 5. care_link_invites
--
-- SELECT só para quem administra o paciente, e mesmo assim o código nunca
-- aparece: a tabela guarda só o hash. Quem aceita o convite não lê esta
-- tabela — a Edge Function resolve com service role.
-- ---------------------------------------------------------------------
drop policy if exists care_link_invites_select on public.care_link_invites;
create policy care_link_invites_select on public.care_link_invites
  for select to authenticated
  using (exists (select 1 from public.care_patients p
                  where p.id = care_link_invites.patient_id
                    and p.owner_user_id = auth.uid()));


-- ---------------------------------------------------------------------
-- 6. conversations
-- ---------------------------------------------------------------------
drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
  for select to authenticated
  using (public.has_patient_access(patient_id));

-- INSERT/UPDATE só por RPC. `last_message_at` é derivado; deixar o cliente
-- escrever permitiria reordenar a lista de conversas alheias.


-- ---------------------------------------------------------------------
-- 7. messages
--
-- O núcleo do §23. Ler exige acesso à conversa. Escrever exige, além disso,
-- que o remetente declarado seja quem realmente está autenticado — mesmo
-- que o RPC já normalize isso, a policy é a segunda barreira, para o caso de
-- alguém acrescentar um caminho de escrita novo e esquecer da checagem.
-- ---------------------------------------------------------------------
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using (public.has_conversation_access(conversation_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    public.has_conversation_access(conversation_id)
    and (sender_user_id is null or sender_user_id = auth.uid())
  );

-- Só o próprio autor apaga a própria mensagem, e só via soft delete.
drop policy if exists messages_soft_delete on public.messages;
create policy messages_soft_delete on public.messages
  for update to authenticated
  using (sender_user_id = auth.uid() and deleted_at is null)
  with check (sender_user_id = auth.uid());


-- ---------------------------------------------------------------------
-- 8. message_receipts
--
-- Cada um marca o próprio recibo. Sem esta restrição, um cuidador poderia
-- marcar como lida uma mensagem que outro cuidador nunca viu — e o paciente
-- veria "✓✓ lida" sem que ninguém tivesse lido.
-- ---------------------------------------------------------------------
drop policy if exists message_receipts_select on public.message_receipts;
create policy message_receipts_select on public.message_receipts
  for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_receipts.message_id
                    and public.has_conversation_access(m.conversation_id)));

drop policy if exists message_receipts_upsert on public.message_receipts;
create policy message_receipts_upsert on public.message_receipts
  for insert to authenticated
  with check (
    recipient_user_id = auth.uid()
    and exists (select 1 from public.messages m
                 where m.id = message_receipts.message_id
                   and public.has_conversation_access(m.conversation_id))
  );

drop policy if exists message_receipts_update_own on public.message_receipts;
create policy message_receipts_update_own on public.message_receipts
  for update to authenticated
  using (recipient_user_id = auth.uid())
  with check (recipient_user_id = auth.uid());


-- ---------------------------------------------------------------------
-- 9. emergency_alerts
--
-- Leitura para quem tem acesso ao paciente. Escrita SÓ por RPC: as
-- transições de estado precisam ser validadas (não se volta de CONFIRMADO
-- para ALERTA_DISPARADO) e auditadas. Um update livre aqui permitiria a um
-- cuidador marcar como CONFIRMADO sem ter visto nada.
-- ---------------------------------------------------------------------
drop policy if exists emergency_alerts_select on public.emergency_alerts;
create policy emergency_alerts_select on public.emergency_alerts
  for select to authenticated
  using (public.has_patient_access(patient_id));


-- ---------------------------------------------------------------------
-- 10. emergency_alert_events — append-only
--
-- Só SELECT. Nem INSERT (é o RPC, security definer, que grava), nem UPDATE,
-- nem DELETE. Trilha de auditoria que o próprio sistema pode reescrever não
-- é trilha de auditoria.
-- ---------------------------------------------------------------------
drop policy if exists emergency_alert_events_select on public.emergency_alert_events;
create policy emergency_alert_events_select on public.emergency_alert_events
  for select to authenticated
  using (exists (select 1 from public.emergency_alerts a
                  where a.id = emergency_alert_events.alert_id
                    and public.has_patient_access(a.patient_id)));


-- ---------------------------------------------------------------------
-- 11. care_patient_presence
-- ---------------------------------------------------------------------
drop policy if exists care_patient_presence_select on public.care_patient_presence;
create policy care_patient_presence_select on public.care_patient_presence
  for select to authenticated
  using (public.has_patient_access(patient_id));

-- Escrita por RPC (touch_presence). Presença escrita direto pelo cliente
-- deixaria um cuidador forjar "online" para um paciente que está fora do ar.


-- ---------------------------------------------------------------------
-- 12. device_push_tokens — estritamente do dono
--
-- Um token de push é endereço de dispositivo. Ler o token alheio permitiria
-- enviar notificação para o celular de outra pessoa por outros caminhos.
-- Ninguém, nem o cuidador principal, lê token de terceiro.
-- ---------------------------------------------------------------------
drop policy if exists device_push_tokens_own on public.device_push_tokens;
create policy device_push_tokens_own on public.device_push_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ---------------------------------------------------------------------
-- 13. notification_deliveries — leitura do próprio destinatário
-- ---------------------------------------------------------------------
drop policy if exists notification_deliveries_own on public.notification_deliveries;
create policy notification_deliveries_own on public.notification_deliveries
  for select to authenticated
  using (user_id = auth.uid());


-- ---------------------------------------------------------------------
-- 14. Revogar o que o PostgREST expõe por padrão
--
-- O papel `authenticated` recebe grants amplos no Supabase. A RLS já
-- bloqueia, mas negar o grant é defesa em profundidade: se uma policy
-- futura for escrita frouxa, o grant ausente ainda segura.
-- ---------------------------------------------------------------------
revoke insert, update, delete on public.care_links              from authenticated;
revoke insert, update, delete on public.care_link_invites       from authenticated;
revoke insert, update, delete on public.conversations           from authenticated;
revoke delete                 on public.messages                from authenticated;
revoke insert, update, delete on public.emergency_alerts        from authenticated;
revoke insert, update, delete on public.emergency_alert_events  from authenticated;
revoke insert, update, delete on public.care_patient_presence   from authenticated;
revoke insert, update, delete on public.notification_deliveries from authenticated;
