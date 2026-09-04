-- =====================================================================
-- IrisFlow — Comunicação Paciente <-> Cuidador
-- Migração 0004: publicação de Realtime e views de leitura
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Realtime
--
-- O Realtime do Supabase respeita RLS: o cliente só recebe as linhas que a
-- policy dele deixaria ler. O `filter` que o cliente passa na inscrição é
-- otimização de banda, NÃO controle de acesso — quem assinasse a conversa de
-- outro paciente simplesmente não receberia nada.
--
-- `care_patient_presence` entra porque a tela do cuidador mostra online/
-- offline sem polling. `messages` e `emergency_alerts` são o essencial.
-- `message_receipts` entra para o paciente ver "✓✓ lida" no instante em que
-- acontece — sem isso, o retorno de leitura só chegaria no próximo fetch.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'messages', 'message_receipts', 'emergency_alerts', 'care_patient_presence'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- REPLICA IDENTITY FULL em emergency_alerts: sem isso, o payload de UPDATE
-- traz só a chave primária e as colunas alteradas, e o cliente não
-- conseguiria distinguir de qual paciente é o alerta sem uma consulta extra
-- — latência que a tela de emergência não pode pagar.
alter table public.emergency_alerts      replica identity full;
alter table public.message_receipts      replica identity full;
alter table public.care_patient_presence replica identity full;


-- ---------------------------------------------------------------------
-- 2. v_caregiver_conversations
--
-- A tela inicial do app do cuidador (§10) em uma consulta: paciente, status,
-- última mensagem, não lidas, alerta ativo. Sem esta view seriam cinco
-- consultas por paciente na abertura do app.
--
-- security_invoker = on: a view roda com as permissões de quem consulta,
-- então a RLS das tabelas de baixo continua valendo. Sem isso, uma view é
-- um buraco na RLS — ela rodaria como o dono e devolveria tudo.
-- ---------------------------------------------------------------------
create or replace view public.v_caregiver_conversations
with (security_invoker = on)
as
select
  c.id                       as conversation_id,
  c.patient_id,
  c.caregiver_user_id,
  p.display_name             as patient_name,
  c.last_message_at,
  coalesce(pr.status, 'unknown')        as patient_status,
  coalesce(pr.irisflow_running, false)  as irisflow_running,
  pr.last_seen_at,
  lm.body                    as last_message_body,
  lm.sender_kind             as last_message_sender,
  lm.urgency                 as last_message_urgency,
  coalesce(un.unread_count, 0)          as unread_count,
  act.id                     as active_alert_id,
  act.state                  as active_alert_state,
  act.triggered_at           as active_alert_at
from public.conversations c
join public.care_patients p
  on p.id = c.patient_id
left join public.care_patient_presence pr
  on pr.patient_id = c.patient_id

-- Última mensagem do fio.
left join lateral (
  select m.body, m.sender_kind, m.urgency
    from public.messages m
   where m.conversation_id = c.id and m.deleted_at is null
   order by m.created_at desc
   limit 1
) lm on true

-- Não lidas por ESTE cuidador. O left join com receipts é o que torna a
-- contagem por destinatário em vez de global — com dois cuidadores, cada um
-- tem o próprio número.
left join lateral (
  select count(*) as unread_count
    from public.messages m
    left join public.message_receipts r
      on r.message_id = m.id and r.recipient_user_id = c.caregiver_user_id
   where m.conversation_id = c.id
     and m.deleted_at is null
     and m.sender_kind = 'patient'
     and r.read_at is null
) un on true

-- Alerta ainda não resolvido. Sem limite de tempo de propósito: um alerta
-- não confirmado de duas horas atrás continua sendo um alerta não
-- confirmado, e sumir da tela seria a pior coisa que essa view poderia fazer.
left join lateral (
  select a.id, a.state, a.triggered_at
    from public.emergency_alerts a
   where a.patient_id = c.patient_id
     and a.state in ('ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO')
   order by a.triggered_at desc
   limit 1
) act on true;

comment on view public.v_caregiver_conversations is
  'Tela inicial do app do cuidador em uma consulta. security_invoker mantém '
  'a RLS das tabelas de baixo valendo para quem consulta.';

grant select on public.v_caregiver_conversations to authenticated;


-- ---------------------------------------------------------------------
-- 3. v_message_status
--
-- O que o paciente precisa saber sobre a própria mensagem: chegou a alguém,
-- alguém leu. Com vários cuidadores, agrega — "entregue" significa entregue
-- a pelo menos um, que é o que importa para quem pediu ajuda.
-- ---------------------------------------------------------------------
create or replace view public.v_message_status
with (security_invoker = on)
as
select
  m.id                                     as message_id,
  m.conversation_id,
  m.client_message_id,
  m.created_at,
  m.server_received_at,
  count(r.recipient_user_id) filter (where r.delivered_at is not null) as delivered_count,
  count(r.recipient_user_id) filter (where r.read_at is not null)      as read_count,
  min(r.delivered_at)                      as first_delivered_at,
  min(r.read_at)                           as first_read_at
from public.messages m
left join public.message_receipts r on r.message_id = m.id
group by m.id;

grant select on public.v_message_status to authenticated;
