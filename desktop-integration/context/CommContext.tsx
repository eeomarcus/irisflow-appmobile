/**
 * Destino: `frontend/src/context/CommContext.tsx`
 *
 * Arquivo NOVO. Camada de comunicação com o cuidador, desacoplada do
 * rastreamento ocular: não importa nada de `src/tracker`, `src/l2cs` ou
 * `src/calibration`, e por isso não há caminho pelo qual frame, landmark ou
 * vetor de calibração alcance a rede (§12, §17).
 *
 * O provider é seguro de montar mesmo sem configuração: `enabled` fica
 * `false`, `supabase` fica `null`, e tudo que depende disso simplesmente não
 * aparece. Nenhuma tela quebra.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Outbox, broadcastPatientMessage, createCommClient, fetchActiveAlert,
  fetchHistory, mergeMessages, newClientId, startPresenceHeartbeat,
  subscribeToConversation, webStorage,
  type CommClient, type EmergencyAlert, type Message,
  type MessageKind, type OutboxItem, type UrgencyLevel,
} from '@irisflow/comm-client';
import { commEnv, commEnabled } from '../config/commEnv';
import { loadPatientSession } from '../utils/patientSession';

interface CommContextValue {
  /** Falso quando não há configuração: a interface deve esconder o recurso. */
  enabled: boolean;
  client: CommClient | null;
  patientId: string | null;

  messages: Message[];
  outbox: readonly OutboxItem[];
  activeAlert: EmergencyAlert | null;
  connection: 'connected' | 'reconnecting' | 'error' | 'off';

  /** Enfileira e devolve o id local. Nunca lança: a fila absorve a falha. */
  send: (body: string, kind?: MessageKind, urgency?: UrgencyLevel) => Promise<string>;
  retry: (clientId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const CommContext = createContext<CommContextValue | null>(null);

export const useComm = (): CommContextValue => {
  const ctx = useContext(CommContext);
  if (!ctx) throw new Error('useComm precisa estar dentro de <CommProvider>');
  return ctx;
};

export const CommProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [patientId, setPatientId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [outboxItems, setOutboxItems] = useState<readonly OutboxItem[]>([]);
  const [activeAlert, setActiveAlert] = useState<EmergencyAlert | null>(null);
  const [connection, setConnection] =
    useState<CommContextValue['connection']>(commEnabled ? 'reconnecting' : 'off');

  // Um cliente por sessão. Dois abririam duas conexões de Realtime e dois
  // relógios de refresh sobre o mesmo token, que se invalidam mutuamente.
  const client = useMemo<CommClient | null>(
    () =>
      commEnabled
        ? createCommClient({
            supabaseUrl: commEnv.supabaseUrl,
            supabaseAnonKey: commEnv.supabaseAnonKey,
            storage: webStorage(),
          })
        : null,
    [],
  );

  /**
   * Id da conversa, em ESTADO e não em ref.
   *
   * Um `useRef` seria o instinto — ele não precisa causar renderização. Mas
   * o efeito de tempo real depende deste valor para assinar o canal, e um
   * ref não dispara efeito nenhum ao ser preenchido. O resultado seria uma
   * conversa recém-criada, ainda sem mensagens, que nunca chegaria a
   * assinar: o cuidador responderia e o paciente não veria nada até
   * reabrir a tela.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);

  /**
   * Outbox persistente em `localStorage`.
   *
   * Persistente aqui, e em memória no app do cuidador, por uma razão
   * concreta: compor uma mensagem pelo olhar custa esforço e tempo. Perdê-la
   * porque o Wi-Fi caiu obrigaria o paciente a refazer tudo — e num quadro
   * de fadiga, "refazer" pode significar desistir.
   */
  const outbox = useRef(
    new Outbox({
      storage: webStorage(),
      send: async (item) => {
        if (!client || !item.patientId) throw new Error('comunicação indisponível');
        const criadas = await broadcastPatientMessage(client.supabase, {
          patientId: item.patientId,
          clientMessageId: item.clientId,
          body: item.body,
          kind: item.kind,
          urgency: item.urgency,
        });
        if (criadas.length === 0) {
          // Sem cuidador vinculado não há para quem enviar. Erro definitivo:
          // retentar não faz aparecer um cuidador, e o outbox precisa marcar
          // `failed` para a tela poder dizer isso em vez de girar para sempre.
          throw Object.assign(new Error('Nenhum cuidador vinculado.'), {
            retryable: false,
          });
        }
        setMessages((atual) => mergeMessages(atual, criadas));
        return { serverId: criadas[0]!.id };
      },
      events: { onChange: setOutboxItems },
    }),
  ).current;

  // ---- identidade do paciente neste computador
  useEffect(() => {
    if (!client) return;
    let vivo = true;
    void (async () => {
      const sessao = await loadPatientSession(client.supabase);
      if (!vivo) return;
      setPatientId(sessao?.patientId ?? commEnv.patientId ?? null);
    })();
    return () => { vivo = false; };
  }, [client]);

  // ---- conversa, histórico e alerta ativo
  const refresh = useCallback(async () => {
    if (!client || !patientId) return;
    try {
      const { data: convs } = await client.supabase
        .from('conversations')
        .select('id')
        .eq('patient_id', patientId)
        .order('created_at')
        .limit(1);

      const conv = convs?.[0]?.id ?? null;
      setConversationId(conv);

      if (conv) {
        const h = await fetchHistory(client.supabase, conv, { limit: 60 });
        setMessages(h);
      }
      setActiveAlert(await fetchActiveAlert(client.supabase, patientId));
    } catch {
      // Falha de rede aqui não é fatal: a tela mostra o que já tem em cache e
      // o Realtime reconecta sozinho.
    }
  }, [client, patientId]);

  useEffect(() => {
    void outbox.load();
    void refresh();
  }, [refresh, outbox]);

  // ---- tempo real
  useEffect(() => {
    if (!client || !patientId || !conversationId) return;
    const sub = subscribeToConversation(client.supabase, {
      conversationId,
      patientId,
      onMessage: (m) => setMessages((atual) => mergeMessages(atual, [m])),
      onAlert: setActiveAlert,
      onStatus: setConnection,
      onCatchUp: () => void refresh(),
    });
    return () => { void sub.unsubscribe(); };
  }, [client, patientId, conversationId, refresh]);

  // ---- presença
  useEffect(() => {
    if (!client || !patientId) return;
    return startPresenceHeartbeat(client.supabase, patientId);
  }, [client, patientId]);

  // ---- conectividade do navegador
  useEffect(() => {
    const online = () => outbox.setOnline(true);
    const offline = () => outbox.setOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    outbox.setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [outbox]);

  const send = useCallback(
    async (body: string, kind: MessageKind = 'quick_phrase', urgency: UrgencyLevel = 'normal') => {
      const clientId = newClientId();
      await outbox.enqueue({
        clientId,
        conversationId: null,
        patientId,
        body,
        kind,
        urgency,
      });
      return clientId;
    },
    [outbox, patientId],
  );

  const retry = useCallback((clientId: string) => outbox.retry(clientId), [outbox]);

  return (
    <CommContext.Provider
      value={{
        enabled: commEnabled && Boolean(client) && Boolean(patientId),
        client,
        patientId,
        messages,
        outbox: outboxItems,
        activeAlert,
        connection,
        send,
        retry,
        refresh,
      }}
    >
      {children}
    </CommContext.Provider>
  );
};
