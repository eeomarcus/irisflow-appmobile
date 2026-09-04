/**
 * emergency-dispatch — escalonamento de alertas não confirmados.
 *
 * Roda por cron (a cada minuto). Procura alertas disparados que ninguém
 * confirmou e reforça o aviso, subindo de nível a cada janela.
 *
 * Por que existe: o push é o elo mais frágil da corrente. O celular pode
 * estar no silencioso, sem bateria, num quarto distante, ou o Android pode
 * ter matado o processo. Nada disso é detectável do servidor — o que é
 * detectável é a AUSÊNCIA de confirmação. É nisso que o escalonamento se
 * baseia: não em supor que o push falhou, mas em constatar que ninguém
 * respondeu.
 *
 * Níveis:
 *   0 → 1  após 60 s sem CONFIRMADO: reenvia para TODOS os cuidadores ativos
 *   1 → 2  após 180 s: reenvia + aciona a ponte externa, se configurada
 *   2 → 3  após 600 s: último reenvio; para de escalar e deixa registrado
 *
 * A ponte externa (SMS / chamada de voz) está DESLIGADA por padrão e sem
 * provedor escolhido — configurar uma exigiria credenciais e uma decisão de
 * custo recorrente que não é minha (§25.20). O contrato do webhook está
 * documentado abaixo; é ligar a URL e o segredo.
 */

import { adminClient, json, CORS } from '../_shared/deps.ts';

const JANELAS = [
  { nivel: 0, aposSegundos: 60,  proximo: 1 },
  { nivel: 1, aposSegundos: 180, proximo: 2 },
  { nivel: 2, aposSegundos: 600, proximo: 3 },
] as const;

const ESTADOS_PENDENTES = ['ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const segredo = Deno.env.get('CRON_SECRET');
  if (segredo && req.headers.get('x-cron-secret') !== segredo) {
    return json({ ok: false, error: 'nao_autorizado' }, 401);
  }

  try {
    const admin = adminClient();
    const agora = Date.now();

    // Nota sobre os estados: ENTREGUE e VISUALIZADO continuam pendentes de
    // propósito. "O cuidador viu na tela" não é "o cuidador vai atender" —
    // só CONFIRMADO significa que alguém assumiu. Parar de escalar em
    // VISUALIZADO seria confiar num sinal que não carrega compromisso.
    const { data: alertas, error } = await admin
      .from('emergency_alerts')
      .select('id, patient_id, category, state, triggered_at, escalation_level, escalated_at')
      .in('state', ESTADOS_PENDENTES)
      .lt('triggered_at', new Date(agora - 60_000).toISOString())
      .lt('escalation_level', 3)
      .order('triggered_at')
      .limit(100);

    if (error) {
      console.error('consulta de alertas', error.message);
      return json({ ok: false, error: 'consulta_falhou' }, 500);
    }
    if (!alertas?.length) return json({ ok: true, escalados: 0 });

    const processados: unknown[] = [];

    for (const a of alertas) {
      const idade = (agora - new Date(a.triggered_at).getTime()) / 1000;
      const janela = JANELAS.find(
        (j) => j.nivel === a.escalation_level && idade >= j.aposSegundos,
      );
      if (!janela) continue;

      const { data: links } = await admin
        .from('care_links')
        .select('caregiver_user_id, role, escalation_order')
        .eq('patient_id', a.patient_id)
        .eq('status', 'active')
        .order('escalation_order');

      // Reservar o nível ANTES de notificar, com a condição do nível atual
      // na própria query. Duas execuções do cron sobrepostas: só uma afeta
      // a linha, a outra vê zero e desiste. Sem isso, um cron atrasado
      // duplicaria cada reforço.
      const { data: reservado } = await admin
        .from('emergency_alerts')
        .update({
          escalation_level: janela.proximo,
          escalated_at: new Date().toISOString(),
        })
        .eq('id', a.id)
        .eq('escalation_level', a.escalation_level)
        .in('state', ESTADOS_PENDENTES)
        .select('id');

      if (!reservado?.length) continue;

      await admin.from('emergency_alert_events').insert({
        alert_id: a.id,
        state: a.state,
        detail: {
          acao: 'escalonamento',
          nivel: janela.proximo,
          idade_segundos: Math.round(idade),
          cuidadores: links?.length ?? 0,
        },
      });

      const reenviados = await reenviarPush(admin, a, links ?? []);

      let ponte: string | null = null;
      if (janela.proximo >= 2) ponte = await acionarPonteExterna(admin, a, links ?? []);

      processados.push({
        alert_id: a.id, nivel: janela.proximo,
        idade_segundos: Math.round(idade), reenviados, ponte,
      });
    }

    return json({ ok: true, escalados: processados.length, detalhe: processados });
  } catch (err) {
    console.error('emergency-dispatch', err instanceof Error ? err.message : String(err));
    return json({ ok: false, error: 'erro_interno' }, 500);
  }
});


/**
 * Reenvia chamando a própria push-fanout, em vez de duplicar a lógica de
 * Expo aqui. Um segundo lugar montando payload de push seria um segundo
 * lugar para o perfil de urgência divergir.
 */
async function reenviarPush(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  alerta: { id: string; patient_id: string; category: string },
  links: Array<{ caregiver_user_id: string }>,
): Promise<number> {
  if (!links.length) return 0;

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const segredo = Deno.env.get('WEBHOOK_SECRET') ?? '';
  if (!url || !key) return 0;

  try {
    const res = await fetch(`${url}/functions/v1/push-fanout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'x-webhook-secret': segredo,
      },
      body: JSON.stringify({
        type: 'INSERT',
        table: 'emergency_alerts',
        record: {
          id: alerta.id,
          patient_id: alerta.patient_id,
          category: alerta.category,
        },
      }),
    });
    return res.ok ? links.length : 0;
  } catch (err) {
    await admin.from('emergency_alert_events').insert({
      alert_id: alerta.id,
      state: 'ALERTA_DISPARADO',
      detail: {
        acao: 'reenvio_falhou',
        erro: err instanceof Error ? err.message.slice(0, 200) : 'desconhecido',
      },
    });
    return 0;
  }
}


/**
 * Ponte externa — SMS ou chamada de voz.
 *
 * DESLIGADA por padrão. Para ligar, defina `EXTERNAL_BRIDGE_URL` (e
 * opcionalmente `EXTERNAL_BRIDGE_SECRET`) apontando para um endpoint seu.
 *
 * Contrato (POST JSON):
 *   { alert_id, patient_id, category, escalation_level,
 *     caregiver_user_ids: string[], triggered_at }
 *
 * Deliberadamente não escolhi provedor. Amarrar Twilio ou Zenvia aqui seria
 * inventar uma integração externa sem verificar a arquitetura real, que é
 * exatamente o que o §4 do briefing proíbe — e traria custo por mensagem,
 * cadastro regulatório e um número de origem, decisões que são do produto.
 *
 * O que a função faz de verdade quando a ponte está desligada: registra na
 * auditoria que não havia canal externo. Assim, num incidente, a pergunta
 * "por que ninguém foi avisado por SMS?" tem resposta escrita.
 */
async function acionarPonteExterna(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  alerta: { id: string; patient_id: string; category: string; triggered_at: string },
  links: Array<{ caregiver_user_id: string }>,
): Promise<string> {
  const url = Deno.env.get('EXTERNAL_BRIDGE_URL');
  if (!url) {
    await admin.from('emergency_alert_events').insert({
      alert_id: alerta.id,
      state: 'ALERTA_DISPARADO',
      detail: { acao: 'ponte_externa', resultado: 'nao_configurada' },
    });
    return 'nao_configurada';
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const s = Deno.env.get('EXTERNAL_BRIDGE_SECRET');
    if (s) headers['x-bridge-secret'] = s;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alert_id: alerta.id,
        patient_id: alerta.patient_id,
        category: alerta.category,
        escalation_level: 2,
        caregiver_user_ids: links.map((l) => l.caregiver_user_id),
        triggered_at: alerta.triggered_at,
      }),
    });

    const resultado = res.ok ? 'enviada' : `falhou_http_${res.status}`;
    await admin.from('emergency_alert_events').insert({
      alert_id: alerta.id,
      state: 'ALERTA_DISPARADO',
      detail: { acao: 'ponte_externa', resultado },
    });
    return resultado;
  } catch (err) {
    await admin.from('emergency_alert_events').insert({
      alert_id: alerta.id,
      state: 'ALERTA_DISPARADO',
      detail: {
        acao: 'ponte_externa',
        resultado: 'erro',
        erro: err instanceof Error ? err.message.slice(0, 200) : 'desconhecido',
      },
    });
    return 'erro';
  }
}
