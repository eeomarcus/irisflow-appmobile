/**
 * link-accept — o cuidador entra no código e ganha o vínculo.
 *
 * Por que isto é uma Edge Function e não um RPC:
 *
 * Para validar o código é preciso ler `care_link_invites`, e a RLS dessa
 * tabela só libera para quem administra o paciente. O cuidador que está
 * aceitando ainda não tem vínculo nenhum — por definição, ele é justamente
 * quem não pode ler. Um RPC `security definer` resolveria, mas exporia uma
 * função capaz de criar vínculos para o `authenticated` inteiro; aqui o
 * service role fica isolado num único arquivo, com uma única entrada.
 *
 * Defesas contra enumeração e força bruta:
 *
 *  - resposta idêntica para código inválido, expirado e já usado. Distinguir
 *    os três diria ao atacante que ele acertou o formato;
 *  - atraso constante de 400 ms em toda resposta negativa, para o tempo não
 *    virar oráculo;
 *  - o código só existe como SHA-256 no banco;
 *  - uso único e expiração de 24 h;
 *  - 31^8 ≈ 8,5×10^11 combinações contra uma janela de 24 h.
 */

import { adminClient, json, sha256Hex, userClient, CORS } from '../_shared/deps.ts';

const RESPOSTA_NEGATIVA = {
  ok: false,
  error: 'codigo_invalido',
  message: 'Código inválido, expirado ou já utilizado.',
} as const;

async function negar(): Promise<Response> {
  // Constante, não proporcional ao trabalho feito: um "não existe" que
  // responde mais rápido que um "expirado" entrega a diferença.
  await new Promise((r) => setTimeout(r, 400));
  return json(RESPOSTA_NEGATIVA, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'metodo' }, 405);

  try {
    // Quem está aceitando precisa estar autenticado — o vínculo é com uma
    // conta, não com um código solto.
    const asUser = userClient(req);
    if (!asUser) return json({ ok: false, error: 'nao_autenticado' }, 401);

    const { data: userData, error: userErr } = await asUser.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: 'nao_autenticado' }, 401);
    const caregiverId = userData.user.id;

    const body = await req.json().catch(() => null);
    const raw = typeof body?.code === 'string' ? body.code : '';
    // Normaliza o que o humano digitou: maiúsculas, sem espaço nem hífen.
    const code = raw.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z2-9]{8}$/.test(code)) return negar();

    const admin = adminClient();
    const hash = await sha256Hex(code);

    const { data: invite } = await admin
      .from('care_link_invites')
      .select('id, patient_id, role, expires_at, used_at')
      .eq('code_hash', hash)
      .maybeSingle();

    if (!invite) return negar();
    if (invite.used_at) return negar();
    if (new Date(invite.expires_at).getTime() < Date.now()) return negar();

    // Consome o convite ANTES de criar o vínculo, com a condição
    // `used_at is null` na própria query. Duas requisições simultâneas com o
    // mesmo código: só uma afeta uma linha, a outra recebe zero e é negada.
    // Fazer na ordem inversa deixaria a janela em que dois vínculos nascem
    // do mesmo convite de uso único.
    const { data: consumido } = await admin
      .from('care_link_invites')
      .update({ used_at: new Date().toISOString(), used_by: caregiverId })
      .eq('id', invite.id)
      .is('used_at', null)
      .select('id');

    if (!consumido || consumido.length === 0) return negar();

    const { data: link, error: linkErr } = await admin
      .from('care_links')
      .upsert(
        {
          patient_id: invite.patient_id,
          caregiver_user_id: caregiverId,
          role: invite.role,
          status: 'active',
          accepted_at: new Date().toISOString(),
          // Principal avisado primeiro; os demais entram na fila de
          // escalonamento da emergência.
          escalation_order: invite.role === 'primary' ? 0 : 1,
        },
        { onConflict: 'patient_id,caregiver_user_id' },
      )
      .select('id, patient_id, role, status')
      .single();

    if (linkErr) {
      console.error('falha ao criar vinculo', linkErr.message);
      return json({ ok: false, error: 'falha_ao_vincular' }, 500);
    }

    // A conversa nasce junto com o vínculo. Criar sob demanda deixaria a
    // primeira mensagem — que pode ser a urgente — esperando um round-trip a
    // mais.
    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .upsert(
        { patient_id: invite.patient_id, caregiver_user_id: caregiverId },
        { onConflict: 'patient_id,caregiver_user_id' },
      )
      .select('id')
      .single();

    if (convErr) {
      console.error('falha ao criar conversa', convErr.message);
      return json({ ok: false, error: 'falha_ao_vincular' }, 500);
    }

    const { data: patient } = await admin
      .from('care_patients')
      .select('display_name')
      .eq('id', invite.patient_id)
      .single();

    return json({
      ok: true,
      link_id: link.id,
      patient_id: link.patient_id,
      // Só o nome de exibição. `beneficiaries`, que guarda a condição
      // clínica, não é tocada aqui — vínculo de comunicação não é
      // autorização para dado de saúde.
      patient_name: patient?.display_name ?? null,
      conversation_id: conv.id,
      role: link.role,
    });
  } catch (err) {
    console.error('link-accept', err instanceof Error ? err.message : String(err));
    return json({ ok: false, error: 'erro_interno' }, 500);
  }
});
