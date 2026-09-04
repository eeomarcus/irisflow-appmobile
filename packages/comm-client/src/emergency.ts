/**
 * Emergência — máquina de estados e envio.
 *
 * A ideia que organiza este arquivo inteiro: o alarme local e o alerta
 * remoto são canais independentes, e o local é o confiável.
 *
 * O alarme sonoro no computador do paciente funciona sem internet, sem
 * servidor, sem celular do cuidador e sem serviço de push. O alerta remoto
 * depende de cinco elos, cada um capaz de falhar em silêncio. Por isso o
 * `EmergencyController` dispara o local primeiro e NUNCA condiciona o alarme
 * ao resultado da rede — e por isso `describeState()` existe: para a tela
 * dizer o que realmente aconteceu em vez de exibir "enviado" por otimismo.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { toCommError } from './client';
import type {
  EmergencyAlert,
  EmergencyCategory,
  EmergencyState,
  ServerEmergencyState,
} from './types';

/**
 * Transições permitidas.
 *
 * O estado só avança. Uma tabela em vez de `if`s espalhados porque a
 * pergunta "isto pode acontecer?" precisa ter uma resposta em um lugar só —
 * e porque um alerta que regride de CONFIRMADO para ALERTA_DISPARADO faria
 * o paciente ver "seu cuidador confirmou" desaparecer da tela.
 */
const TRANSICOES: Record<EmergencyState, readonly EmergencyState[]> = {
  ENVIANDO: ['ALERTA_DISPARADO', 'FALHA_DE_ENVIO', 'CANCELADO'],
  ALERTA_DISPARADO: ['ENTREGUE', 'VISUALIZADO', 'CONFIRMADO', 'CANCELADO', 'FALHA_DE_ENVIO'],
  ENTREGUE: ['VISUALIZADO', 'CONFIRMADO', 'CANCELADO'],
  VISUALIZADO: ['CONFIRMADO', 'CANCELADO'],
  CONFIRMADO: [],
  CANCELADO: [],
  FALHA_DE_ENVIO: ['ALERTA_DISPARADO', 'CANCELADO'],  // uma retentativa tardia pode vingar
};

export function canTransition(de: EmergencyState, para: EmergencyState): boolean {
  if (de === para) return true;   // idempotência: reaplicar o mesmo estado é permitido
  return TRANSICOES[de].includes(para);
}

/** Estados em que ninguém assumiu o chamado ainda. */
export function isUnresolved(state: EmergencyState): boolean {
  return state === 'ENVIANDO'
    || state === 'ALERTA_DISPARADO'
    || state === 'ENTREGUE'
    || state === 'VISUALIZADO';
}

export interface StateDescription {
  title: string;
  detail: string;
  tone: 'sending' | 'pending' | 'good' | 'bad';
  /** O alarme sonoro local deve continuar tocando? */
  keepAlarm: boolean;
}

/**
 * O que a tela do paciente pode honestamente afirmar em cada estado.
 *
 * `FALHA_DE_ENVIO` é a linha que justifica todo o resto. O código atual do
 * Blinkv1 exibe "Seu alerta foi enviado" mesmo sem servidor algum; aqui, uma
 * falha de rede vira uma frase que diz a verdade e aponta o que ainda está
 * funcionando — o som. Alguém sozinho em casa precisa saber se a ajuda foi
 * chamada ou se depende de quem estiver por perto ouvir.
 */
export function describeState(state: EmergencyState): StateDescription {
  switch (state) {
    case 'ENVIANDO':
      return {
        title: 'Enviando alerta…',
        detail: 'O alarme sonoro já está tocando.',
        tone: 'sending',
        keepAlarm: true,
      };
    case 'ALERTA_DISPARADO':
      return {
        title: 'Alerta registrado',
        detail: 'Estamos avisando seu cuidador agora.',
        tone: 'pending',
        keepAlarm: true,
      };
    case 'ENTREGUE':
      return {
        title: 'Seu cuidador recebeu o alerta',
        detail: 'Aguarde a confirmação.',
        tone: 'pending',
        keepAlarm: true,
      };
    case 'VISUALIZADO':
      return {
        title: 'Seu cuidador está vendo o alerta',
        detail: 'Aguarde a confirmação.',
        tone: 'pending',
        keepAlarm: true,
      };
    case 'CONFIRMADO':
      return {
        title: 'Seu cuidador confirmou',
        detail: 'Ele está vindo até você.',
        tone: 'good',
        // Só aqui o alarme para: alguém assumiu o chamado.
        keepAlarm: false,
      };
    case 'CANCELADO':
      return {
        title: 'Alerta cancelado',
        detail: 'Nenhum socorro foi solicitado.',
        tone: 'good',
        keepAlarm: false,
      };
    case 'FALHA_DE_ENVIO':
      return {
        title: 'Não consegui avisar pela internet',
        detail: 'O alarme sonoro continua tocando para chamar quem estiver por perto.',
        tone: 'bad',
        keepAlarm: true,
      };
  }
}

export interface TriggerArgs {
  patientId: string;
  clientAlertId: string;
  category?: EmergencyCategory;
  note?: string;
}

export async function triggerEmergency(
  supabase: SupabaseClient,
  args: TriggerArgs,
): Promise<EmergencyAlert> {
  const { data, error } = await supabase.rpc('trigger_emergency', {
    p_patient_id: args.patientId,
    p_client_alert_id: args.clientAlertId,
    p_category: args.category ?? 'other',
    p_note: args.note ?? null,
  });
  if (error) throw toCommError(error);
  return normalizarAlerta(data);
}

/**
 * Chamada pelo APP DO CUIDADOR ao receber o alerta.
 *
 * Nunca pelo serviço de push: um ticket aceito pelo Expo diz que o Expo
 * aceitou, não que o celular acordou (§25.19). Quem sabe que o alerta chegou
 * é o código rodando no aparelho do cuidador.
 */
export async function markEmergencyDelivered(
  supabase: SupabaseClient,
  alertId: string,
): Promise<EmergencyAlert> {
  const { data, error } = await supabase.rpc('mark_emergency_delivered', {
    p_alert_id: alertId,
  });
  if (error) throw toCommError(error);
  return normalizarAlerta(data);
}

export async function markEmergencySeen(
  supabase: SupabaseClient,
  alertId: string,
): Promise<EmergencyAlert> {
  const { data, error } = await supabase.rpc('mark_emergency_seen', {
    p_alert_id: alertId,
  });
  if (error) throw toCommError(error);
  return normalizarAlerta(data);
}

/** "RECEBI, ESTOU INDO" — o passo do §20 que fecha o ciclo para o paciente. */
export async function acknowledgeEmergency(
  supabase: SupabaseClient,
  alertId: string,
): Promise<EmergencyAlert> {
  const { data, error } = await supabase.rpc('acknowledge_emergency', {
    p_alert_id: alertId,
  });
  if (error) throw toCommError(error);
  return normalizarAlerta(data);
}

export async function cancelEmergency(
  supabase: SupabaseClient,
  alertId: string,
): Promise<EmergencyAlert> {
  const { data, error } = await supabase.rpc('cancel_emergency', {
    p_alert_id: alertId,
  });
  if (error) throw toCommError(error);
  return normalizarAlerta(data);
}

export async function failEmergency(
  supabase: SupabaseClient,
  alertId: string,
  reason: string,
): Promise<EmergencyAlert> {
  const { data, error } = await supabase.rpc('fail_emergency', {
    p_alert_id: alertId,
    p_reason: reason,
  });
  if (error) throw toCommError(error);
  return normalizarAlerta(data);
}

export async function fetchActiveAlert(
  supabase: SupabaseClient,
  patientId: string,
): Promise<EmergencyAlert | null> {
  const { data, error } = await supabase
    .from('emergency_alerts')
    .select('*')
    .eq('patient_id', patientId)
    .in('state', ['ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO'])
    .order('triggered_at', { ascending: false })
    .limit(1);

  if (error) throw toCommError(error);
  return (data?.[0] as EmergencyAlert) ?? null;
}


export interface EmergencyControllerOptions {
  supabase: SupabaseClient | null;
  patientId: string | null;
  /** Alarme local. Deve funcionar sem rede — é a camada confiável. */
  startLocalAlarm: () => void;
  stopLocalAlarm: () => void;
  onStateChange: (state: EmergencyState, alert: EmergencyAlert | null) => void;
  now?: () => number;
  /** Espera entre retentativas. Injetável para o teste não esperar de verdade. */
  delay?: (ms: number) => Promise<void>;
  /** Tempo total tentando registrar no servidor antes de FALHA_DE_ENVIO. */
  maxSendWindowMs?: number;
}

/**
 * Orquestra um acionamento de emergência.
 *
 * Ordem das operações, que é o que este controlador existe para garantir:
 *
 *   1. alarme local          — imediato, incondicional
 *   2. estado ENVIANDO       — a tela já mostra algo honesto
 *   3. registro no servidor  — com retentativa dentro de uma janela
 *   4. estado real           — vindo do servidor, ou FALHA_DE_ENVIO
 *
 * O passo 1 nunca depende do 3. É a diferença entre um sistema de emergência
 * e um sistema de mensagens com o texto em vermelho.
 */
export class EmergencyController {
  private state: EmergencyState = 'CANCELADO';
  private alert: EmergencyAlert | null = null;
  private clientAlertId: string | null = null;
  private iniciadoEm = 0;
  private tentativas = 0;
  private encerrado = true;

  private readonly opts: Required<
    Pick<EmergencyControllerOptions, 'startLocalAlarm' | 'stopLocalAlarm' | 'onStateChange'>
  > & EmergencyControllerOptions;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly janelaMs: number;

  constructor(opts: EmergencyControllerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.delay =
      opts.delay ?? ((ms) => new Promise<void>((r) => void setTimeout(r, ms)));
    this.janelaMs = opts.maxSendWindowMs ?? 120_000;
  }

  getState(): EmergencyState { return this.state; }
  getAlert(): EmergencyAlert | null { return this.alert; }

  async trigger(clientAlertId: string, category: EmergencyCategory = 'other'): Promise<void> {
    // 1. Sempre, antes de tudo, sem await e sem condição.
    this.opts.startLocalAlarm();

    this.clientAlertId = clientAlertId;
    this.iniciadoEm = this.now();
    this.tentativas = 0;
    this.encerrado = false;
    this.setState('ENVIANDO');

    const { supabase, patientId } = this.opts;
    if (!supabase || !patientId) {
      // Sem backend configurado: nada de fingir. Falha explícita, alarme
      // tocando, e a tela dizendo exatamente isso.
      this.setState('FALHA_DE_ENVIO');
      return;
    }

    await this.tentarRegistrar(category);
  }

  /**
   * Laço de retentativa.
   *
   * Um laço aguardado, e não um `setTimeout` que se reagenda: assim
   * `trigger()` só resolve quando o alerta chegou a um estado definitivo —
   * registrado ou `FALHA_DE_ENVIO`. Com o reagendamento solto, quem
   * chamasse `await trigger()` receberia o controle de volta ainda em
   * `ENVIANDO`, e não haveria como saber, de fora, se o alerta vingou.
   *
   * A interface não espera por isto: ela chama sem `await` e reage pelo
   * `onStateChange`. Quem espera é o teste — e é justamente o que torna a
   * garantia verificável.
   */
  private async tentarRegistrar(category: EmergencyCategory): Promise<void> {
    const { supabase, patientId } = this.opts;
    if (!supabase || !patientId || !this.clientAlertId) return;

    while (!this.encerrado) {
      this.tentativas += 1;
      try {
        const alerta = await triggerEmergency(supabase, {
          patientId,
          clientAlertId: this.clientAlertId,   // idempotente: retentar é seguro
          category,
        });
        this.alert = alerta;
        this.setState(alerta.state);
        return;
      } catch (err) {
        const e = err as { retryable?: boolean; message?: string };
        const decorrido = this.now() - this.iniciadoEm;

        if (e?.retryable === false || decorrido >= this.janelaMs) {
          this.setState('FALHA_DE_ENVIO');
          return;
        }

        // Backoff curto: 500ms, 1s, 2s, 4s, teto de 5s. Bem mais agressivo
        // que o do outbox comum — aqui a latência tem custo humano, e a
        // janela inteira dura dois minutos.
        await this.delay(Math.min(500 * 2 ** (this.tentativas - 1), 5_000));
      }
    }
  }

  /** Aplica um estado vindo do Realtime, respeitando a máquina de estados. */
  applyServerState(alerta: EmergencyAlert): void {
    if (this.alert && alerta.id !== this.alert.id) return;
    if (!canTransition(this.state, alerta.state)) return;
    this.alert = alerta;
    this.setState(alerta.state);
  }

  async cancel(): Promise<void> {
    this.encerrado = true;
    this.opts.stopLocalAlarm();

    const { supabase } = this.opts;
    if (supabase && this.alert) {
      try {
        const a = await cancelEmergency(supabase, this.alert.id);
        this.alert = a;
      } catch {
        // Cancelar é um pedido do paciente, não uma negociação com a rede: a
        // tela sai do modo de alerta de qualquer forma.
      }
    }
    this.setState('CANCELADO');
  }

  private setState(novo: EmergencyState): void {
    if (this.state === novo) return;
    this.state = novo;

    // O alarme para exatamente onde `describeState` diz que para. Uma fonte
    // só para a regra evita a divergência clássica entre "o que a tela diz"
    // e "o que o som faz".
    if (!describeState(novo).keepAlarm) {
      this.encerrado = true;
      this.opts.stopLocalAlarm();
    }

    this.opts.onStateChange(novo, this.alert);
  }
}

function normalizarAlerta(data: unknown): EmergencyAlert {
  const linha = Array.isArray(data) ? data[0] : data;
  if (!linha) throw toCommError({ message: 'resposta vazia do servidor' });
  return linha as EmergencyAlert;
}

export type { ServerEmergencyState };
