/**
 * push-fanout — envia a notificação para os dispositivos do destinatário.
 *
 * Acionada por Database Webhook em `messages` (INSERT) e em
 * `emergency_alerts` (INSERT). Fala com o Expo Push Service, que por sua vez
 * fala com APNs e FCM.
 *
 * A regra que governa este arquivo inteiro (§25.19 do briefing):
 *
 *   Um ticket aceito pelo Expo NÃO é uma entrega.
 *
 * Por isso nada aqui escreve `delivered_at` em `emergency_alerts`. O que se
 * grava é `notification_deliveries`, que responde "o que nós despachamos".
 * Quem responde "o cuidador recebeu" é o app do cuidador, chamando
 * `mark_emergency_delivered`. Confundir as duas coisas é o jeito mais fácil
 * de construir um sistema de emergência que parece funcionar.
 */

import { adminClient, json, CORS } from '../_shared/deps.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type Urgencia = 'normal' | 'importante' | 'urgente' | 'emergencia';

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: Record<string, unknown> | null;
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: string | null;
  priority: 'default' | 'normal' | 'high';
  channelId?: string;
  ttl?: number;
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
  badge?: number;
}

/**
 * Perfil de entrega por urgência (§5 e §8).
 *
 * `ttl` é a parte menos óbvia e a mais importante: uma emergência que só
 * chega 40 minutos depois é pior que inútil — ela informa mal. 300 s e o
 * push morre; o que segura o caso é o escalonamento, não uma notificação
 * atrasada.
 */
const PERFIL: Record<Urgencia, {
  priority: 'default' | 'high';
  channelId: string;
  sound: string | null;
  interruptionLevel: ExpoMessage['interruptionLevel'];
  ttl: number;
}> = {
  normal:     { priority: 'default', channelId: 'mensagens',  sound: 'default', interruptionLevel: 'passive',        ttl: 86_400 },
  importante: { priority: 'high',    channelId: 'mensagens',  sound: 'default', interruptionLevel: 'active',         ttl: 43_200 },
  urgente:    { priority: 'high',    channelId: 'urgente',    sound: 'default', interruptionLevel: 'time-sensitive', ttl: 3_600 },
  emergencia: { priority: 'high',    channelId: 'emergencia', sound: 'default', interruptionLevel: 'critical',       ttl: 300 },
};

const CATEGORIA_PT: Record<string, string> = {
  pain: 'Dor',
  breath: 'Falta de ar',
  cold: 'Frio',
  other: 'Ajuda',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'metodo' }, 405);

  // O webhook do Supabase não assina o corpo. Um segredo compartilhado no
  // header é o que impede alguém de chamar esta função direto e disparar
  // push arbitrário para os dispositivos dos cuidadores.
  const segredo = Deno.env.get('WEBHOOK_SECRET');
  if (segredo && req.headers.get('x-webhook-secret') !== segredo) {
    return json({ ok: false, error: 'nao_autorizado' }, 401);
  }

  try {
    const payload = (await req.json()) as WebhookPayload;
    if (!payload?.record) return json({ ok: true, skipped: 'sem_record' });

    const admin = adminClient();

    if (payload.table === 'messages' && payload.type === 'INSERT') {
      return await notificarMensagem(admin, payload.record);
    }
    if (payload.table === 'emergency_alerts' && payload.type === 'INSERT') {
      return await notificarEmergencia(admin, payload.record);
    }
    return json({ ok: true, skipped: `${payload.table}:${payload.type}` });
  } catch (err) {
    console.error('push-fanout', err instanceof Error ? err.message : String(err));
    return json({ ok: false, error: 'erro_interno' }, 500);
  }
});


// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notificarMensagem(admin: any, rec: Record<string, unknown>) {
  const conversationId = rec.conversation_id as string;
  const senderKind = rec.sender_kind as string;
  const senderId = (rec.sender_user_id as string | null) ?? null;
  const urgency = ((rec.urgency as string) ?? 'normal') as Urgencia;

  const { data: conv } = await admin
    .from('conversations')
    .select('patient_id, caregiver_user_id, care_patients(display_name)')
    .eq('id', conversationId)
    .single();
  if (!conv) return json({ ok: true, skipped: 'conversa_ausente' });

  // Notifica o outro lado. Sem esta checagem, o cuidador receberia push da
  // própria mensagem.
  const destinatario =
    senderKind === 'patient' ? conv.caregiver_user_id : null;
  if (!destinatario || destinatario === senderId) {
    return json({ ok: true, skipped: 'remetente_e_destinatario' });
  }

  const nome = conv.care_patients?.display_name ?? 'Paciente';
  const corpo = String(rec.body ?? '');
  const perfil = PERFIL[urgency] ?? PERFIL.normal;

  return await despachar(admin, {
    userId: destinatario,
    title: urgency === 'urgente' ? `⚠️ ${nome}` : nome,
    // Prévia truncada. Notificação de tela bloqueada é visível para quem
    // estiver por perto; 120 caracteres bastam para decidir se abre agora.
    body: corpo.length > 120 ? `${corpo.slice(0, 117)}…` : corpo,
    urgency,
    perfil,
    data: {
      tipo: 'mensagem',
      conversation_id: conversationId,
      message_id: rec.id,
      patient_id: conv.patient_id,
      urgency,
    },
    ref: { message_id: rec.id as string },
  });
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notificarEmergencia(admin: any, rec: Record<string, unknown>) {
  const patientId = rec.patient_id as string;
  const alertId = rec.id as string;

  const { data: patient } = await admin
    .from('care_patients')
    .select('display_name')
    .eq('id', patientId)
    .single();

  // TODOS os cuidadores ativos, de uma vez. Emergência não escalona no
  // primeiro disparo: escalonar significaria deixar o secundário sem saber
  // enquanto o principal talvez esteja dormindo. O `emergency-dispatch`
  // reforça depois; aqui todo mundo é avisado já.
  const { data: links } = await admin
    .from('care_links')
    .select('caregiver_user_id')
    .eq('patient_id', patientId)
    .eq('status', 'active')
    .order('escalation_order');

  if (!links?.length) {
    // Fato importante o bastante para virar linha de auditoria: o alerta
    // existe e não há ninguém para avisar.
    await admin.from('emergency_alert_events').insert({
      alert_id: alertId,
      state: 'ALERTA_DISPARADO',
      detail: { push: 'sem_cuidador_vinculado' },
    });
    return json({ ok: true, skipped: 'sem_cuidadores' });
  }

  const nome = patient?.display_name ?? 'Paciente';
  const categoria = CATEGORIA_PT[String(rec.category ?? 'other')] ?? 'Ajuda';
  const perfil = PERFIL.emergencia;

  const resultados = [];
  for (const l of links) {
    const r = await despachar(admin, {
      userId: l.caregiver_user_id,
      title: '🚨 EMERGÊNCIA',
      body: `${nome} precisa de ajuda agora — ${categoria}`,
      urgency: 'emergencia',
      perfil,
      data: { tipo: 'emergencia', alert_id: alertId, patient_id: patientId },
      ref: { alert_id: alertId },
      raw: true,
    });
    resultados.push(r);
  }

  return json({ ok: true, destinatarios: links.length, resultados });
}


interface DespachoArgs {
  userId: string;
  title: string;
  body: string;
  urgency: Urgencia;
  perfil: (typeof PERFIL)[Urgencia];
  data: Record<string, unknown>;
  ref: { message_id?: string; alert_id?: string };
  raw?: boolean;
}

async function despachar(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  { userId, title, body, urgency, perfil, data, ref, raw }: DespachoArgs,
) {
  const { data: tokens } = await admin
    .from('device_push_tokens')
    .select('id, token, platform, critical_ok')
    .eq('user_id', userId)
    .is('disabled_at', null);

  if (!tokens?.length) {
    // Registrado, não engolido: "o cuidador não tem dispositivo registrado"
    // precisa ser consultável depois de um incidente.
    await admin.from('notification_deliveries').insert({
      user_id: userId, urgency, status: 'error',
      error_code: 'sem_token_registrado', ...ref,
    });
    const r = { userId, enviados: 0, erro: 'sem_token_registrado' };
    return raw ? r : json({ ok: true, ...r });
  }

  const mensagens: ExpoMessage[] = tokens.map(
    (t: { token: string; critical_ok: boolean }) => ({
      to: t.token,
      title,
      body,
      data,
      sound: perfil.sound,
      priority: perfil.priority,
      channelId: perfil.channelId,
      ttl: perfil.ttl,
      // `critical` sem o entitlement da Apple faz a APNs rejeitar a
      // notificação inteira — o cuidador não receberia NADA. Degradar para
      // time-sensitive entrega e ainda fura o modo Foco.
      interruptionLevel:
        perfil.interruptionLevel === 'critical' && !t.critical_ok
          ? 'time-sensitive'
          : perfil.interruptionLevel,
    }),
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
  const expoToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (expoToken) headers.Authorization = `Bearer ${expoToken}`;

  let tickets: Array<{ status?: string; id?: string; details?: { error?: string } }> = [];
  let falha: string | null = null;

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST', headers, body: JSON.stringify(mensagens),
    });
    const payload = await res.json();
    if (!res.ok) {
      falha = `http_${res.status}`;
    } else {
      tickets = Array.isArray(payload?.data) ? payload.data : [];
    }
  } catch (err) {
    falha = err instanceof Error ? err.message.slice(0, 100) : 'erro_de_rede';
  }

  const registros = tokens.map((t: { id: string }, i: number) => {
    const ticket = tickets[i];
    const erro = falha ?? ticket?.details?.error ?? null;
    return {
      user_id: userId, token_id: t.id, urgency, provider: 'expo',
      ticket_id: ticket?.id ?? null,
      status: !erro && ticket?.status === 'ok' ? 'accepted' : 'error',
      error_code: erro, ...ref,
    };
  });
  await admin.from('notification_deliveries').insert(registros);

  // DeviceNotRegistered = o app foi desinstalado ou o token rodou. Desativar
  // evita continuar gastando o orçamento de push num aparelho morto e, mais
  // importante, evita a ilusão de que existe um canal ativo ali.
  const mortos = tokens
    .filter((_: unknown, i: number) => tickets[i]?.details?.error === 'DeviceNotRegistered')
    .map((t: { id: string }) => t.id);
  if (mortos.length) {
    await admin.from('device_push_tokens')
      .update({ disabled_at: new Date().toISOString() })
      .in('id', mortos);
  }

  const aceitos = registros.filter((r) => r.status === 'accepted').length;
  const r = { userId, enviados: aceitos, total: tokens.length, erro: falha };
  return raw ? r : json({ ok: true, ...r });
}
