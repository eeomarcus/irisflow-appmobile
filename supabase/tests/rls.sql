-- =====================================================================
-- Testes de Row Level Security
--
-- Rode no SQL Editor DEPOIS de aplicar 0001..0004, em um projeto de
-- desenvolvimento. Cria usuários e dados falsos, verifica, e desfaz tudo
-- com rollback ao final.
--
-- Nenhum dado real é usado (§23: "Não utilize dados sensíveis reais durante
-- testes"). Nomes e e-mails são fictícios.
--
-- O que estes testes existem para provar é UM fato: um cuidador não alcança
-- o paciente de outro. É a garantia da qual todo o resto do produto depende,
-- e é exatamente o tipo de coisa que uma policy mal escrita quebra sem
-- avisar — nenhum erro aparece, os dados só ficam visíveis.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Cenário
--
--   Ana    — cuidadora do Paulo (vínculo ativo)
--   Bruno  — cuidador da Marta  (vínculo ativo). NÃO tem nada com o Paulo.
--   Carla  — foi cuidadora do Paulo, vínculo REVOGADO.
-- ---------------------------------------------------------------------
insert into auth.users (id, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'ana.teste@exemplo.invalid',   '', now(), '{}', '{}', now(), now(), 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'bruno.teste@exemplo.invalid', '', now(), '{}', '{}', now(), now(), 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'carla.teste@exemplo.invalid', '', now(), '{}', '{}', now(), now(), 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.care_patients (id, owner_user_id, display_name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Paulo (teste)'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Marta (teste)');

insert into public.care_links (patient_id, caregiver_user_id, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'primary',   'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'primary',   'active'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'secondary', 'revoked');

insert into public.conversations (id, patient_id, caregiver_user_id) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222');

insert into public.messages (id, conversation_id, client_message_id, sender_kind, body) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'ffffffff-ffff-ffff-ffff-ffffffffffff', 'patient', 'Mensagem do Paulo');

insert into public.emergency_alerts (id, patient_id, client_alert_id, category) values
  ('99999999-9999-9999-9999-999999999999', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '88888888-8888-8888-8888-888888888888', 'pain');


-- ---------------------------------------------------------------------
-- Auxiliar: assume a identidade de um usuário, como o PostgREST faz.
-- ---------------------------------------------------------------------
create or replace function pg_temp.como(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text,
                     true);
end $$;

create or replace function pg_temp.verificar(p_nome text, p_ok boolean) returns void
language plpgsql as $$
begin
  if p_ok then
    raise notice 'PASSOU  %', p_nome;
  else
    raise exception 'FALHOU  %', p_nome;
  end if;
end $$;


-- =====================================================================
-- 1. Vínculo ativo enxerga o próprio paciente
-- =====================================================================
select pg_temp.como('11111111-1111-1111-1111-111111111111');

select pg_temp.verificar('Ana vê o Paulo',
  (select count(*) from public.care_patients
    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 1);

select pg_temp.verificar('Ana lê a conversa dela',
  (select count(*) from public.messages
    where conversation_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc') = 1);

select pg_temp.verificar('Ana vê o alerta do Paulo',
  (select count(*) from public.emergency_alerts
    where patient_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 1);


-- =====================================================================
-- 2. IDOR — o teste que mais importa (§23)
--
-- Bruno é um cuidador legítimo, autenticado, com vínculo válido. Ele
-- simplesmente não tem nada com o Paulo. Todas as consultas abaixo pedem
-- os dados do Paulo pelo id EXATO — o cenário do atacante que descobriu ou
-- adivinhou um uuid.
--
-- A resposta correta não é erro: é ZERO LINHAS. A RLS filtra antes de
-- qualquer código da aplicação rodar.
-- =====================================================================
select pg_temp.como('22222222-2222-2222-2222-222222222222');

select pg_temp.verificar('Bruno NÃO vê o paciente da Ana',
  (select count(*) from public.care_patients
    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 0);

select pg_temp.verificar('Bruno NÃO vê a conversa da Ana',
  (select count(*) from public.conversations
    where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc') = 0);

select pg_temp.verificar('Bruno NÃO lê as mensagens do Paulo',
  (select count(*) from public.messages
    where conversation_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc') = 0);

select pg_temp.verificar('Bruno NÃO vê o alerta do Paulo',
  (select count(*) from public.emergency_alerts
    where patient_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 0);

select pg_temp.verificar('Bruno NÃO vê a presença do Paulo',
  (select count(*) from public.care_patient_presence
    where patient_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 0);

select pg_temp.verificar('has_patient_access nega o Paulo para o Bruno',
  public.has_patient_access('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = false);

-- Um "select *" sem filtro devolve só o mundo dele. É o caso do app com bug
-- que esqueceu o where: a RLS segura mesmo assim.
select pg_temp.verificar('Listagem irrestrita do Bruno traz só a Marta',
  (select count(*) from public.care_patients) = 1);


-- =====================================================================
-- 3. Revogação corta o acesso imediatamente
--
-- Carla teve vínculo. Ele foi revogado — não apagado, para o histórico e a
-- auditoria continuarem íntegros. Ela não pode ler mais nada.
-- =====================================================================
select pg_temp.como('33333333-3333-3333-3333-333333333333');

select pg_temp.verificar('Vínculo revogado NÃO dá acesso ao paciente',
  (select count(*) from public.care_patients
    where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 0);

select pg_temp.verificar('Vínculo revogado NÃO lê mensagens',
  (select count(*) from public.messages) = 0);

select pg_temp.verificar('Vínculo revogado NÃO vê alertas',
  (select count(*) from public.emergency_alerts) = 0);


-- =====================================================================
-- 4. Escrita forjada
-- =====================================================================
select pg_temp.como('22222222-2222-2222-2222-222222222222');

-- Insert direto na conversa alheia: barrado pela policy de messages.
do $$
begin
  insert into public.messages (conversation_id, client_message_id, sender_kind, body)
  values ('cccccccc-cccc-cccc-cccc-cccccccccccc',
          gen_random_uuid(), 'caregiver', 'invasão');
  raise exception 'FALHOU  Bruno conseguiu escrever na conversa da Ana';
exception
  when insufficient_privilege or check_violation then
    raise notice 'PASSOU  Bruno NÃO escreve na conversa da Ana';
end $$;

-- RPC com patient_id alheio: barrado por can_write_to_patient.
do $$
begin
  perform public.send_message(
    'cccccccc-cccc-cccc-cccc-cccccccccccc', gen_random_uuid(), 'invasão');
  raise exception 'FALHOU  send_message aceitou conversa alheia';
exception
  when insufficient_privilege then
    raise notice 'PASSOU  send_message recusa conversa alheia';
end $$;

-- Disparar emergência em nome de outro paciente.
do $$
begin
  perform public.trigger_emergency(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', gen_random_uuid(), 'pain');
  raise exception 'FALHOU  trigger_emergency aceitou paciente alheio';
exception
  when insufficient_privilege then
    raise notice 'PASSOU  trigger_emergency recusa paciente alheio';
end $$;

-- Criar vínculo consigo mesmo — o caminho mais direto para o acesso total.
do $$
begin
  insert into public.care_links (patient_id, caregiver_user_id, status)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '22222222-2222-2222-2222-222222222222', 'active');
  raise exception 'FALHOU  Bruno criou vínculo com o paciente da Ana';
exception
  when insufficient_privilege or check_violation then
    raise notice 'PASSOU  Bruno NÃO cria vínculo por conta própria';
end $$;

-- Confirmar emergência alheia.
do $$
begin
  perform public.acknowledge_emergency('99999999-9999-9999-9999-999999999999');
  raise exception 'FALHOU  Bruno confirmou emergência alheia';
exception
  when insufficient_privilege then
    raise notice 'PASSOU  Bruno NÃO confirma emergência alheia';
end $$;


-- =====================================================================
-- 5. Idempotência (dedupe e anti-replay)
-- =====================================================================
select pg_temp.como('11111111-1111-1111-1111-111111111111');

do $$
declare
  v_cli uuid := gen_random_uuid();
  a public.messages; b public.messages;
begin
  a := public.send_message('cccccccc-cccc-cccc-cccc-cccccccccccc', v_cli, 'Estou com sede.');
  -- Segunda chamada idêntica: é o outbox retentando após um timeout, ou um
  -- replay de requisição capturada. Nos dois casos, uma linha só.
  b := public.send_message('cccccccc-cccc-cccc-cccc-cccccccccccc', v_cli, 'Estou com sede.');
  perform pg_temp.verificar('Reenvio devolve a MESMA mensagem', a.id = b.id);
  perform pg_temp.verificar('Reenvio não cria linha nova',
    (select count(*) from public.messages where client_message_id = v_cli) = 1);
end $$;

do $$
declare
  v_cli uuid := gen_random_uuid();
  a public.emergency_alerts; b public.emergency_alerts;
begin
  a := public.trigger_emergency('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v_cli, 'breath');
  b := public.trigger_emergency('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', v_cli, 'breath');
  perform pg_temp.verificar('Retentativa de alerta devolve o MESMO alerta', a.id = b.id);

  -- client_alert_id diferente, dentro dos 30 s: reacionamento pelo olhar ou
  -- abuso do endpoint. Converge para o alerta ativo em vez de criar outro —
  -- o cuidador não pode receber quatro telas de emergência do mesmo evento.
  b := public.trigger_emergency(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', gen_random_uuid(), 'breath');
  perform pg_temp.verificar('Janela de 30 s converge para o alerta ativo', a.id = b.id);
end $$;


-- =====================================================================
-- 6. Máquina de estados do alerta
-- =====================================================================
do $$
declare a public.emergency_alerts;
begin
  a := public.mark_emergency_seen('99999999-9999-9999-9999-999999999999');
  perform pg_temp.verificar('ALERTA_DISPARADO -> VISUALIZADO', a.state = 'VISUALIZADO');
  perform pg_temp.verificar('VISUALIZADO preenche delivered_at', a.delivered_at is not null);

  a := public.acknowledge_emergency('99999999-9999-9999-9999-999999999999');
  perform pg_temp.verificar('VISUALIZADO -> CONFIRMADO', a.state = 'CONFIRMADO');

  -- Segundo toque no botão não é um segundo evento.
  a := public.acknowledge_emergency('99999999-9999-9999-9999-999999999999');
  perform pg_temp.verificar('Confirmar de novo é idempotente', a.state = 'CONFIRMADO');

  perform pg_temp.verificar('Cada transição virou linha de auditoria',
    (select count(*) from public.emergency_alert_events
      where alert_id = '99999999-9999-9999-9999-999999999999') >= 2);
end $$;


-- =====================================================================
-- 7. Auditoria é append-only
-- =====================================================================
do $$
begin
  update public.emergency_alert_events set state = 'CANCELADO'
   where alert_id = '99999999-9999-9999-9999-999999999999';
  raise exception 'FALHOU  Auditoria pôde ser reescrita';
exception
  when insufficient_privilege then
    raise notice 'PASSOU  Auditoria NÃO pode ser alterada';
end $$;

do $$
begin
  delete from public.emergency_alert_events
   where alert_id = '99999999-9999-9999-9999-999999999999';
  raise exception 'FALHOU  Auditoria pôde ser apagada';
exception
  when insufficient_privilege then
    raise notice 'PASSOU  Auditoria NÃO pode ser apagada';
end $$;


-- =====================================================================
-- 8. Recibos e tokens de push
-- =====================================================================
do $$
begin
  -- Marcar recibo em nome de outra pessoa faria o paciente ver "✓✓ lida"
  -- sem que ninguém tivesse lido.
  insert into public.message_receipts (message_id, recipient_user_id, read_at)
  values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          '22222222-2222-2222-2222-222222222222', now());
  raise exception 'FALHOU  Recibo criado em nome de terceiro';
exception
  when insufficient_privilege or check_violation then
    raise notice 'PASSOU  Recibo só pode ser do próprio usuário';
end $$;

select pg_temp.como('22222222-2222-2222-2222-222222222222');
insert into public.device_push_tokens (user_id, token, platform)
values ('22222222-2222-2222-2222-222222222222', 'ExponentPushToken[teste]', 'android');

select pg_temp.como('11111111-1111-1111-1111-111111111111');
select pg_temp.verificar('Ninguém lê token de push alheio',
  (select count(*) from public.device_push_tokens) = 0);


-- =====================================================================
-- 9. Anônimo não alcança nada
-- =====================================================================
set local role anon;
select pg_temp.verificar('Anônimo não lê pacientes',  (select count(*) from public.care_patients) = 0);
select pg_temp.verificar('Anônimo não lê mensagens',  (select count(*) from public.messages) = 0);
select pg_temp.verificar('Anônimo não lê alertas',    (select count(*) from public.emergency_alerts) = 0);

reset role;
rollback;

-- Se chegou até aqui sem exceção, todos os testes passaram.
-- Cada `raise notice` acima mostra o resultado individual.
