/**
 * Destino: `frontend/src/utils/patientSession.ts`
 *
 * Arquivo NOVO. Sessão de dispositivo do paciente.
 *
 * Por que o paciente não faz login:
 *
 * Digitar e-mail e senha pelo olhar é hostil no melhor dos casos e
 * impossível numa recaída motora — e teria que ser refeito a cada expiração
 * de token. Um sistema de comunicação de emergência não pode ter, no
 * caminho crítico, uma etapa que o usuário pode perder a capacidade de
 * executar.
 *
 * Então o vínculo é do COMPUTADOR: alguém autentica uma vez na configuração
 * inicial, e a partir daí a máquina opera como aquele paciente, com o
 * refresh token renovando sozinho.
 *
 * A consequência é honesta: quem tem acesso físico à máquina tem acesso à
 * conversa. É a máquina dele, na casa dele — o mesmo modelo do WhatsApp
 * Desktop. O que não seria aceitável é essa sessão alcançar OUTROS
 * pacientes, e a RLS garante que não alcança: mesmo com o token em mãos, o
 * Postgres só devolve as linhas dos pacientes vinculados àquela conta.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const CHAVE = 'irisflow_patient_device_v1';

export interface PatientSession {
  patientId: string;
  patientName: string;
  vinculadoEm: string;
}

/**
 * Grava o vínculo do dispositivo.
 *
 * Guarda apenas id e nome. O token de acesso NÃO passa por aqui: quem o
 * persiste é o próprio SDK do Supabase, através do `StorageAdapter` que o
 * `CommProvider` injeta. Duplicar o token em outra chave seria criar uma
 * segunda cópia do segredo, que ninguém lembraria de limpar no logout.
 */
export async function savePatientSession(s: PatientSession): Promise<void> {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(s));
  } catch {
    // Sem storage, o vínculo vale só para esta execução. Melhor do que
    // impedir o paciente de se comunicar hoje.
  }
}

/**
 * Lê o vínculo e CONFIRMA contra o servidor.
 *
 * A validação não é zelo: se o cuidador revogou o vínculo pelo app, o
 * `localStorage` deste computador continua dizendo que existe. Sem checar,
 * a tela ofereceria "Falar com cuidador" para um canal que a RLS já fechou,
 * e cada envio falharia sem explicação. Melhor descobrir na abertura.
 */
export async function loadPatientSession(
  supabase: SupabaseClient,
): Promise<PatientSession | null> {
  let bruto: string | null = null;
  try {
    bruto = localStorage.getItem(CHAVE);
  } catch {
    return null;
  }
  if (!bruto) return null;

  let s: PatientSession;
  try {
    s = JSON.parse(bruto) as PatientSession;
  } catch {
    return null;
  }
  if (!s?.patientId) return null;

  const { data: sessao } = await supabase.auth.getSession();
  if (!sessao.session) {
    // Sem sessão: o refresh token expirou de vez (meses offline) ou foi
    // limpo. O vínculo local fica, para a tela poder dizer o que aconteceu
    // e pedir um novo pareamento em vez de sumir sem explicação.
    return null;
  }

  const { data, error } = await supabase
    .from('care_patients')
    .select('id, display_name')
    .eq('id', s.patientId)
    .maybeSingle();

  // Zero linhas por RLS = acesso revogado. Limpar aqui evita a tela oferecer
  // um canal que já não existe.
  if (error || !data) {
    await clearPatientSession();
    return null;
  }

  return { ...s, patientName: data.display_name };
}

export async function clearPatientSession(): Promise<void> {
  try {
    localStorage.removeItem(CHAVE);
  } catch {
    /* nada a limpar */
  }
}

/**
 * Pareia este computador com um paciente, a partir das credenciais do
 * cuidador. Roda uma vez, na configuração inicial.
 */
export async function pairDevice(
  supabase: SupabaseClient,
  email: string,
  senha: string,
  patientId: string,
): Promise<{ ok: true; session: PatientSession } | { ok: false; error: string }> {
  const { error: erroLogin } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: senha,
  });
  if (erroLogin) {
    return {
      ok: false,
      error: erroLogin.message === 'Invalid login credentials'
        ? 'E-mail ou senha incorretos.'
        : erroLogin.message,
    };
  }

  // Confirma que a conta realmente alcança este paciente. A RLS já
  // impediria a leitura, mas falhar aqui produz uma mensagem clara em vez de
  // uma tela vazia depois.
  const { data, error } = await supabase
    .from('care_patients')
    .select('id, display_name')
    .eq('id', patientId)
    .maybeSingle();

  if (error || !data) {
    await supabase.auth.signOut();
    return { ok: false, error: 'Esta conta não tem acesso a este paciente.' };
  }

  const session: PatientSession = {
    patientId: data.id,
    patientName: data.display_name,
    vinculadoEm: new Date().toISOString(),
  };
  await savePatientSession(session);
  return { ok: true, session };
}
