-- =====================================================================
-- IrisFlow — Comunicação Paciente <-> Cuidador
-- Migração 0003: funções RPC (a "API")
--
-- Princípio único deste arquivo: o cliente NUNCA informa quem ele é.
-- patient_id, caregiver_id e sender_id são sempre derivados de auth.uid()
-- ou da conversa, nunca aceitos como parâmetro de identidade. Isso elimina
-- por construção a família inteira de ataques do §23 ("alteração de
-- patient_id", "alteração de caregiver_id").
--
-- Toda função é SECURITY DEFINER com search_path fixo e revalida o acesso
-- via has_patient_access(), mesmo quando a RLS já validaria — security
-- definer desliga a RLS, então a checagem tem que ser explícita.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. send_message
--
-- Idempotente por (conversation_id, client_message_id). Reenviar é sucesso:
-- devolve a linha que já existe. É o contrato que permite ao outbox retentar
-- sem medo depois de um timeout — e um timeout NÃO significa que a mensagem
-- não chegou, só que a resposta não voltou.
-- ---------------------------------------------------------------------
create or replace function public.send_message(
  p_conversation_id   uuid,
  p_client_message_id uuid,
  p_body              text,
  p_kind              public.message_kind_t default 'text',
  p_urgency           public.urgency_t      default 'normal'
)
returns public.messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv        public.conversations;
  v_sender_kind public.sender_kind_t;
  v_patient     public.care_patients;
  v_row         public.messages;
  v_recent      integer;
begin
  if auth.uid() is null then
    raise exception 'nao autenticado' using errcode = '28000';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;
  if not found then
    -- Mesma mensagem para "não existe" e "não é sua": distinguir os dois
    -- transformaria este endpoint num oráculo de existência de conversas.
    raise exception 'conversa inacessivel' using errcode = '42501';
  end if;

  if not public.can_write_to_patient(v_conv.patient_id) then
    raise exception 'conversa inacessivel' using errcode = '42501';
  end if;

  -- Quem está falando é deduzido, não declarado. Se auth.uid() é o cuidador
  -- daquela conversa, é 'caregiver'; se é o dono/paciente, é 'patient'.
  if v_conv.caregiver_user_id = auth.uid() then
    v_sender_kind := 'caregiver';
  else
    select * into v_patient from public.care_patients where id = v_conv.patient_id;
    if v_patient.user_id = auth.uid() or v_patient.owner_user_id = auth.uid() then
      v_sender_kind := 'patient';
    else
      raise exception 'conversa inacessivel' using errcode = '42501';
    end if;
  end if;

  -- Rate limit por conversa. 'emergencia' é isenta de propósito: limitar o
  -- canal que salva a pessoa para conter spam seria a troca errada.
  if p_urgency <> 'emergencia' then
    select count(*) into v_recent
      from public.messages m
     where m.conversation_id = p_conversation_id
       and m.sender_kind = v_sender_kind
       and m.created_at > now() - interval '1 minute';
    if v_recent >= 60 then
      raise exception 'limite de mensagens por minuto atingido'
        using errcode = '54000';
    end if;
  end if;

  insert into public.messages as m
    (conversation_id, client_message_id, sender_kind, sender_user_id,
     kind, urgency, body)
  values
    (p_conversation_id, p_client_message_id, v_sender_kind, auth.uid(),
     p_kind, p_urgency, btrim(p_body))
  on conflict (conversation_id, client_message_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Já existia: retentativa ou replay. Devolver a linha original mantém o
    -- cliente idempotente e neutraliza o replay ao mesmo tempo.
    select * into v_row
      from public.messages
     where conversation_id = p_conversation_id
       and client_message_id = p_client_message_id;
    return v_row;
  end if;

  update public.conversations
     set last_message_at = v_row.server_received_at
   where id = p_conversation_id;

  if v_sender_kind = 'patient' then
    insert into public.care_patient_presence (patient_id, last_message_at)
    values (v_conv.patient_id, v_row.server_received_at)
    on conflict (patient_id) do update
      set last_message_at = excluded.last_message_at;
  end if;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. broadcast_patient_message
--
-- O paciente escolhe uma frase uma vez; ela precisa chegar a todos os
-- cuidadores vinculados. Sem isto, o paciente teria que escolher para quem
-- falar — uma decisão a mais numa interface que o §21 manda enxugar.
--
-- O client_message_id é o mesmo em todas as conversas: a unique é por
-- conversa, então não colide, e a retentativa continua idempotente em todas.
-- ---------------------------------------------------------------------
create or replace function public.broadcast_patient_message(
  p_patient_id        uuid,
  p_client_message_id uuid,
  p_body              text,
  p_kind              public.message_kind_t default 'quick_phrase',
  p_urgency           public.urgency_t      default 'normal'
)
returns setof public.messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv public.conversations;
begin
  if not public.can_write_to_patient(p_patient_id) then
    raise exception 'paciente inacessivel' using errcode = '42501';
  end if;

  for v_conv in
    select c.* from public.conversations c
      join public.care_links l
        on l.patient_id = c.patient_id
       and l.caregiver_user_id = c.caregiver_user_id
     where c.patient_id = p_patient_id
       and l.status = 'active'
     order by l.escalation_order
  loop
    return query
      select * from public.send_message(
        v_conv.id, p_client_message_id, p_body, p_kind, p_urgency);
  end loop;

  return;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Recibos
--
-- Sempre para auth.uid(). O parâmetro é a lista de mensagens, nunca o
-- destinatário — deixar o cliente escolher o destinatário permitiria marcar
-- como lida uma mensagem que outra pessoa nunca viu.
-- ---------------------------------------------------------------------
create or replace function public.mark_messages_delivered(p_message_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if auth.uid() is null then
    raise exception 'nao autenticado' using errcode = '28000';
  end if;

  with alvo as (
    select m.id from public.messages m
     where m.id = any(p_message_ids)
       and public.has_conversation_access(m.conversation_id)
       -- Ninguém "recebe" a própria mensagem.
       and coalesce(m.sender_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
           <> auth.uid()
  )
  insert into public.message_receipts (message_id, recipient_user_id, delivered_at)
  select alvo.id, auth.uid(), now() from alvo
  on conflict (message_id, recipient_user_id) do update
    set delivered_at = coalesce(public.message_receipts.delivered_at, now());

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


create or replace function public.mark_messages_read(p_message_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if auth.uid() is null then
    raise exception 'nao autenticado' using errcode = '28000';
  end if;

  with alvo as (
    select m.id from public.messages m
     where m.id = any(p_message_ids)
       and public.has_conversation_access(m.conversation_id)
       and coalesce(m.sender_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
           <> auth.uid()
  )
  insert into public.message_receipts
    (message_id, recipient_user_id, delivered_at, read_at)
  select alvo.id, auth.uid(), now(), now() from alvo
  on conflict (message_id, recipient_user_id) do update
    -- Lida implica entregue. Se o push falhou mas o cuidador abriu o app e
    -- leu, delivered_at não pode continuar nulo.
    set delivered_at = coalesce(public.message_receipts.delivered_at, now()),
        read_at      = coalesce(public.message_receipts.read_at, now());

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. trigger_emergency
--
-- Duas proteções contra acionamento repetido, com propósitos diferentes:
--
--   a) client_alert_id  — retentativa do outbox. O mesmo alerta reenviado
--      devolve a mesma linha.
--   b) janela de 30 s   — acionamento repetido pelo olhar, ou tentativa de
--      abuso do endpoint (§23). Devolve o alerta ATIVO em vez de criar um
--      segundo, para o cuidador não receber quatro telas de emergência do
--      mesmo evento.
--
-- Nenhuma das duas rejeita a chamada. Rejeitar um disparo de emergência para
-- conter abuso seria a troca errada; o certo é convergir para um alerta só.
-- ---------------------------------------------------------------------
create or replace function public.trigger_emergency(
  p_patient_id      uuid,
  p_client_alert_id uuid,
  p_category        text default 'other',
  p_note            text default null
)
returns public.emergency_alerts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.emergency_alerts;
  v_active public.emergency_alerts;
begin
  if not public.can_write_to_patient(p_patient_id) then
    raise exception 'paciente inacessivel' using errcode = '42501';
  end if;

  -- (a) retentativa do mesmo alerta
  select * into v_row
    from public.emergency_alerts
   where patient_id = p_patient_id and client_alert_id = p_client_alert_id;
  if found then
    return v_row;
  end if;

  -- (b) já existe alerta ativo recente
  select * into v_active
    from public.emergency_alerts
   where patient_id = p_patient_id
     and state in ('ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO')
     and triggered_at > now() - interval '30 seconds'
   order by triggered_at desc
   limit 1;
  if found then
    insert into public.emergency_alert_events (alert_id, state, actor_id, detail)
    values (v_active.id, v_active.state, auth.uid(),
            jsonb_build_object('reason', 'reacionamento_dentro_da_janela',
                               'client_alert_id', p_client_alert_id));
    return v_active;
  end if;

  insert into public.emergency_alerts
    (patient_id, client_alert_id, category, note, state)
  values
    (p_patient_id, p_client_alert_id,
     coalesce(nullif(p_category, ''), 'other'), p_note, 'ALERTA_DISPARADO')
  returning * into v_row;

  insert into public.emergency_alert_events (alert_id, state, actor_id, detail)
  values (v_row.id, 'ALERTA_DISPARADO', auth.uid(),
          jsonb_build_object('category', v_row.category));

  insert into public.care_patient_presence (patient_id, last_alert_at)
  values (p_patient_id, v_row.triggered_at)
  on conflict (patient_id) do update set last_alert_at = excluded.last_alert_at;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Transições de estado do alerta
--
-- Uma função por transição, cada uma com a guarda de qual estado pode
-- precedê-la. Um update genérico permitiria voltar de CONFIRMADO para
-- ALERTA_DISPARADO, ou pular direto para CONFIRMADO sem ninguém ter visto —
-- e a auditoria registraria a mentira com a mesma seriedade que a verdade.
-- ---------------------------------------------------------------------

-- Chamada pelo APP do cuidador ao receber (realtime ou handler de push).
-- Não é chamada pelo serviço de push: ticket aceito não é entrega (§25.19).
create or replace function public.mark_emergency_delivered(p_alert_id uuid)
returns public.emergency_alerts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.emergency_alerts;
begin
  select * into v_row from public.emergency_alerts where id = p_alert_id;
  if not found or not public.has_patient_access(v_row.patient_id) then
    raise exception 'alerta inacessivel' using errcode = '42501';
  end if;

  if v_row.state <> 'ALERTA_DISPARADO' then
    return v_row;   -- já avançou; não regride
  end if;

  update public.emergency_alerts
     set state = 'ENTREGUE', delivered_at = coalesce(delivered_at, now())
   where id = p_alert_id
  returning * into v_row;

  insert into public.emergency_alert_events (alert_id, state, actor_id)
  values (p_alert_id, 'ENTREGUE', auth.uid());

  return v_row;
end;
$$;


create or replace function public.mark_emergency_seen(p_alert_id uuid)
returns public.emergency_alerts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.emergency_alerts;
begin
  select * into v_row from public.emergency_alerts where id = p_alert_id;
  if not found or not public.has_patient_access(v_row.patient_id) then
    raise exception 'alerta inacessivel' using errcode = '42501';
  end if;

  if v_row.state not in ('ALERTA_DISPARADO', 'ENTREGUE') then
    return v_row;
  end if;

  update public.emergency_alerts
     set state        = 'VISUALIZADO',
         delivered_at = coalesce(delivered_at, now()),
         seen_at      = coalesce(seen_at, now())
   where id = p_alert_id
  returning * into v_row;

  insert into public.emergency_alert_events (alert_id, state, actor_id)
  values (p_alert_id, 'VISUALIZADO', auth.uid());

  return v_row;
end;
$$;


-- "RECEBI, ESTOU INDO". O passo do §20 que fecha o ciclo para o paciente.
create or replace function public.acknowledge_emergency(p_alert_id uuid)
returns public.emergency_alerts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.emergency_alerts;
begin
  select * into v_row from public.emergency_alerts where id = p_alert_id;
  if not found or not public.has_patient_access(v_row.patient_id) then
    raise exception 'alerta inacessivel' using errcode = '42501';
  end if;

  if v_row.state = 'CANCELADO' then
    raise exception 'alerta ja cancelado pelo paciente' using errcode = '22023';
  end if;
  if v_row.state = 'CONFIRMADO' then
    return v_row;   -- idempotente: dois toques no botão não são dois eventos
  end if;

  update public.emergency_alerts
     set state           = 'CONFIRMADO',
         delivered_at    = coalesce(delivered_at, now()),
         seen_at         = coalesce(seen_at, now()),
         acknowledged_at = now(),
         acknowledged_by = auth.uid()
   where id = p_alert_id
  returning * into v_row;

  insert into public.emergency_alert_events (alert_id, state, actor_id)
  values (p_alert_id, 'CONFIRMADO', auth.uid());

  return v_row;
end;
$$;


-- Cancelamento pelo paciente (ou por quem administra). Um cuidador vinculado
-- NÃO cancela: só quem disparou pode dizer que não era nada.
create or replace function public.cancel_emergency(p_alert_id uuid)
returns public.emergency_alerts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.emergency_alerts;
  v_pat public.care_patients;
begin
  select * into v_row from public.emergency_alerts where id = p_alert_id;
  if not found then
    raise exception 'alerta inacessivel' using errcode = '42501';
  end if;

  select * into v_pat from public.care_patients where id = v_row.patient_id;
  if not (v_pat.owner_user_id = auth.uid() or v_pat.user_id = auth.uid()) then
    raise exception 'apenas o paciente pode cancelar o proprio alerta'
      using errcode = '42501';
  end if;

  if v_row.state in ('CANCELADO', 'CONFIRMADO') then
    return v_row;
  end if;

  update public.emergency_alerts
     set state = 'CANCELADO', cancelled_at = now()
   where id = p_alert_id
  returning * into v_row;

  insert into public.emergency_alert_events (alert_id, state, actor_id)
  values (p_alert_id, 'CANCELADO', auth.uid());

  return v_row;
end;
$$;


-- FALHA_DE_ENVIO é reportada pelo cliente que desistiu de retentar. Só faz
-- sentido para um alerta que ele conseguiu registrar mas cujo ciclo travou;
-- quando nem a linha existe, a falha é puramente local (o outbox sabe) e
-- nada disto roda.
create or replace function public.fail_emergency(p_alert_id uuid, p_reason text)
returns public.emergency_alerts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.emergency_alerts;
begin
  select * into v_row from public.emergency_alerts where id = p_alert_id;
  if not found or not public.can_write_to_patient(v_row.patient_id) then
    raise exception 'alerta inacessivel' using errcode = '42501';
  end if;

  if v_row.state in ('CONFIRMADO', 'CANCELADO') then
    return v_row;
  end if;

  update public.emergency_alerts
     set state = 'FALHA_DE_ENVIO', failed_at = now(),
         failure_reason = left(coalesce(p_reason, 'desconhecida'), 300)
   where id = p_alert_id
  returning * into v_row;

  insert into public.emergency_alert_events (alert_id, state, actor_id, detail)
  values (p_alert_id, 'FALHA_DE_ENVIO', auth.uid(),
          jsonb_build_object('reason', p_reason));

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. Vínculo
-- ---------------------------------------------------------------------

-- Devolve o código EM TEXTO CLARO uma única vez, aqui. O banco guarda só o
-- SHA-256; não existe caminho para lê-lo de novo. Perdeu, gera outro.
create or replace function public.create_link_invite(
  p_patient_id uuid,
  p_role       public.care_role_t default 'secondary'
)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Sem 0/O e 1/I/L: o código costuma ser ditado por telefone ou copiado de
  -- um papel, e "zero ou ó" é uma falha de usabilidade que vira falha de
  -- suporte.
  v_alfabeto constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code     text := '';
  v_expira   timestamptz := now() + interval '24 hours';
  i          integer;
begin
  if not exists (select 1 from public.care_patients p
                  where p.id = p_patient_id and p.owner_user_id = auth.uid()) then
    raise exception 'apenas quem administra o paciente pode convidar'
      using errcode = '42501';
  end if;

  for i in 1..8 loop
    v_code := v_code || substr(v_alfabeto,
                               1 + floor(random() * length(v_alfabeto))::int, 1);
  end loop;

  insert into public.care_link_invites
    (patient_id, code_hash, role, created_by, expires_at)
  values
    (p_patient_id, encode(digest(v_code, 'sha256'), 'hex'),
     p_role, auth.uid(), v_expira);

  return query select v_code, v_expira;
end;
$$;


create or replace function public.revoke_link(p_link_id uuid)
returns public.care_links
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.care_links;
begin
  select * into v_row from public.care_links where id = p_link_id;
  if not found or not exists (select 1 from public.care_patients p
                               where p.id = v_row.patient_id
                                 and p.owner_user_id = auth.uid()) then
    raise exception 'vinculo inacessivel' using errcode = '42501';
  end if;

  -- status, não delete: a conversa e a auditoria precisam continuar
  -- apontando para um vínculo que existiu.
  update public.care_links
     set status = 'revoked', revoked_at = now()
   where id = p_link_id
  returning * into v_row;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 7. Presença e push
-- ---------------------------------------------------------------------
create or replace function public.touch_presence(
  p_patient_id       uuid,
  p_irisflow_running boolean default true
)
returns public.care_patient_presence
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.care_patient_presence;
begin
  if not public.can_write_to_patient(p_patient_id) then
    raise exception 'paciente inacessivel' using errcode = '42501';
  end if;

  insert into public.care_patient_presence
    (patient_id, status, irisflow_running, last_seen_at)
  values (p_patient_id, 'online', p_irisflow_running, now())
  on conflict (patient_id) do update
    set status           = 'online',
        irisflow_running = excluded.irisflow_running,
        last_seen_at     = now()
  returning * into v_row;

  return v_row;
end;
$$;


-- Marca offline quem não dá sinal há mais de 3 minutos (heartbeat é de 60 s,
-- então três batidas perdidas). Roda por cron.
create or replace function public.expire_stale_presence()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update public.care_patient_presence
     set status = 'offline', irisflow_running = false
   where status = 'online'
     and last_seen_at < now() - interval '3 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


create or replace function public.register_push_token(
  p_token       text,
  p_platform    public.push_platform_t,
  p_device      text default null,
  p_critical_ok boolean default false
)
returns public.device_push_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.device_push_tokens;
begin
  if auth.uid() is null then
    raise exception 'nao autenticado' using errcode = '28000';
  end if;

  insert into public.device_push_tokens
    (user_id, token, platform, device_label, critical_ok)
  values (auth.uid(), p_token, p_platform, p_device, p_critical_ok)
  on conflict (token) do update
    -- O token migra de dono quando outra pessoa entra no mesmo aparelho.
    -- Sem esta linha, o cuidador anterior continuaria recebendo os alertas.
    set user_id      = auth.uid(),
        platform     = excluded.platform,
        device_label = excluded.device_label,
        critical_ok  = excluded.critical_ok,
        last_seen_at = now(),
        disabled_at  = null
  returning * into v_row;

  return v_row;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. Retenção (§12)
--
-- Mensagens: 12 meses. Alertas e eventos de auditoria: NUNCA por aqui. São
-- registro de segurança, e apagá-los automaticamente destruiria a única
-- resposta para "quando o cuidador soube?".
-- ---------------------------------------------------------------------
create or replace function public.purge_old_messages(p_months integer default 12)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  delete from public.messages
   where created_at < now() - make_interval(months => p_months);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- ---------------------------------------------------------------------
-- 9. Grants
--
-- Só as funções que o cliente pode chamar. purge_old_messages e
-- expire_stale_presence ficam de fora: são cron, e permitir que o app
-- dispare uma limpeza seria dar a ele um botão de apagar histórico.
-- ---------------------------------------------------------------------
grant execute on function public.send_message(uuid, uuid, text,
  public.message_kind_t, public.urgency_t)                to authenticated;
grant execute on function public.broadcast_patient_message(uuid, uuid, text,
  public.message_kind_t, public.urgency_t)                to authenticated;
grant execute on function public.mark_messages_delivered(uuid[])  to authenticated;
grant execute on function public.mark_messages_read(uuid[])       to authenticated;
grant execute on function public.trigger_emergency(uuid, uuid, text, text)
                                                                  to authenticated;
grant execute on function public.mark_emergency_delivered(uuid)   to authenticated;
grant execute on function public.mark_emergency_seen(uuid)        to authenticated;
grant execute on function public.acknowledge_emergency(uuid)      to authenticated;
grant execute on function public.cancel_emergency(uuid)           to authenticated;
grant execute on function public.fail_emergency(uuid, text)       to authenticated;
grant execute on function public.create_link_invite(uuid, public.care_role_t)
                                                                  to authenticated;
grant execute on function public.revoke_link(uuid)                to authenticated;
grant execute on function public.touch_presence(uuid, boolean)    to authenticated;
grant execute on function public.register_push_token(text, public.push_platform_t,
  text, boolean)                                                  to authenticated;

revoke execute on function public.purge_old_messages(integer)   from authenticated, anon;
revoke execute on function public.expire_stale_presence()       from authenticated, anon;
