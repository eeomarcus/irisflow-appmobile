/**
 * Assinaturas de tempo real.
 *
 * O que este arquivo resolve e que o SDK sozinho não resolve: `SUBSCRIBED`
 * não significa "não perdi nada".
 *
 * O SDK reconecta com backoff quando a rede oscila — e reconecta em
 * silêncio. As mensagens que chegaram durante a queda simplesmente não
 * existem para o cliente: elas não estão na tela, ninguém sabe que
 * faltaram, e a próxima mensagem que chegar vai fazer parecer que está tudo
 * certo. Num app de conversa comum isso é um incômodo. Aqui, a mensagem
 * perdida pode ser "Preciso de ajuda".
 *
 * Por isso toda subscrição bem-sucedida dispara um catch-up:
 * `fetchSince(lastSeenAt)` + deduplicação. O Realtime dá latência baixa; o
 * catch-up dá a garantia.
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { EmergencyAlert, Message, MessageReceipt } from './types';

export interface ConversationSubscription {
  channel: RealtimeChannel;
  unsubscribe: () => Promise<void>;
}

export interface SubscribeArgs {
  conversationId: string;
  patientId: string;
  onMessage: (m: Message) => void;
  onReceipt?: (r: MessageReceipt) => void;
  onAlert?: (a: EmergencyAlert) => void;
  /**
   * Chamado a cada (re)conexão. Deve buscar o que chegou desde `since` e
   * mesclar. Nada aqui presume que a conexão foi contínua.
   */
  onCatchUp?: (since: string | null) => void | Promise<void>;
  onStatus?: (status: 'connected' | 'reconnecting' | 'error') => void;
  /** `created_at` da mensagem mais recente já conhecida. */
  lastSeenAt?: string | null;
}

export function subscribeToConversation(
  supabase: SupabaseClient,
  args: SubscribeArgs,
): ConversationSubscription {
  let ultimoVisto = args.lastSeenAt ?? null;

  const channel = supabase
    .channel(`conversation:${args.conversationId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        // Filtro de banda, não de segurança: o Realtime respeita RLS, então
        // uma inscrição na conversa alheia não devolveria linha alguma.
        filter: `conversation_id=eq.${args.conversationId}`,
      },
      (payload) => {
        const m = payload.new as Message;
        if (!ultimoVisto || m.created_at > ultimoVisto) ultimoVisto = m.created_at;
        args.onMessage(m);
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'message_receipts' },
      (payload) => {
        // Sem filtro de servidor: `message_receipts` não tem conversation_id,
        // e filtrar por message_id exigiria uma inscrição por mensagem. A RLS
        // já restringe às conversas acessíveis; quem descarta o resto é a
        // tela, que sabe quais ids está exibindo.
        const r = (payload.new ?? payload.old) as MessageReceipt;
        if (r) args.onReceipt?.(r);
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'emergency_alerts',
        filter: `patient_id=eq.${args.patientId}`,
      },
      (payload) => {
        const a = (payload.new ?? payload.old) as EmergencyAlert;
        if (a) args.onAlert?.(a);
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        args.onStatus?.('connected');
        // Aqui está o ponto do arquivo: conectado ≠ em dia.
        void args.onCatchUp?.(ultimoVisto);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        args.onStatus?.('error');
      } else if (status === 'CLOSED') {
        args.onStatus?.('reconnecting');
      }
    });

  return {
    channel,
    unsubscribe: async () => {
      await supabase.removeChannel(channel);
    },
  };
}

/**
 * Assina os alertas de um paciente sem abrir a conversa.
 *
 * Usado pela lista de pacientes no app do cuidador: um alerta precisa
 * aparecer mesmo que a conversa daquele paciente não esteja aberta. Um canal
 * por paciente na lista, fechado ao sair da tela.
 */
export function subscribeToPatientAlerts(
  supabase: SupabaseClient,
  patientId: string,
  onAlert: (a: EmergencyAlert) => void,
): ConversationSubscription {
  const channel = supabase
    .channel(`patient-alerts:${patientId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'emergency_alerts',
        filter: `patient_id=eq.${patientId}`,
      },
      (payload) => {
        const a = payload.new as EmergencyAlert;
        if (a) onAlert(a);
      },
    )
    .subscribe();

  return {
    channel,
    unsubscribe: async () => {
      await supabase.removeChannel(channel);
    },
  };
}

/**
 * Heartbeat de presença do paciente.
 *
 * 60 s é escolha deliberada. Mais frequente viraria rastreamento de
 * atividade minuto a minuto — o §11 pede status, e no mesmo parágrafo
 * proíbe vigilância. Menos frequente faria "online" significar pouco.
 *
 * A primeira batida é imediata: abrir o IrisFlow e o cuidador continuar
 * vendo "offline" por um minuto seria informação errada no momento em que
 * ela mais importa.
 */
export function startPresenceHeartbeat(
  supabase: SupabaseClient,
  patientId: string,
  opts: { intervalMs?: number; onError?: (e: unknown) => void } = {},
): () => void {
  const intervalo = opts.intervalMs ?? 60_000;

  const bater = async () => {
    try {
      const { error } = await supabase.rpc('touch_presence', {
        p_patient_id: patientId,
        p_irisflow_running: true,
      });
      if (error) opts.onError?.(error);
    } catch (e) {
      // Falha de heartbeat não é falha do produto: o paciente segue usando o
      // IrisFlow normalmente, e o servidor marca offline sozinho depois de
      // 3 minutos sem sinal.
      opts.onError?.(e);
    }
  };

  void bater();
  const timer = setInterval(() => void bater(), intervalo);
  return () => clearInterval(timer);
}
