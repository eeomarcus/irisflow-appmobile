/**
 * Envio, histórico e recibos de mensagem.
 *
 * Nada aqui faz `insert` direto em `messages`. Tudo passa pelos RPCs, que
 * derivam `sender_kind` e `sender_user_id` de `auth.uid()`. Isso não é
 * cerimônia: é o que impede o cliente de declarar quem ele é.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { toCommError } from './client';
import type {
  CaregiverConversation,
  Message,
  MessageKind,
  MessageStatus,
  UrgencyLevel,
} from './types';

export interface SendMessageArgs {
  conversationId: string;
  clientMessageId: string;
  body: string;
  kind?: MessageKind;
  urgency?: UrgencyLevel;
}

/**
 * Envia para uma conversa.
 *
 * Idempotente pelo par (conversa, clientMessageId): reenviar devolve a
 * mensagem original, com o mesmo `id`. O chamador não precisa distinguir
 * "criou" de "já existia" — para ele, os dois são sucesso.
 */
export async function sendMessage(
  supabase: SupabaseClient,
  args: SendMessageArgs,
): Promise<Message> {
  const { data, error } = await supabase.rpc('send_message', {
    p_conversation_id: args.conversationId,
    p_client_message_id: args.clientMessageId,
    p_body: args.body,
    p_kind: args.kind ?? 'text',
    p_urgency: args.urgency ?? 'normal',
  });
  if (error) throw toCommError(error);
  return normalizarUm(data);
}

/**
 * Uma escolha do paciente vira uma mensagem em cada conversa ativa.
 *
 * O `clientMessageId` é o mesmo para todas: a unique é por conversa, então
 * não colide, e a retentativa continua idempotente em cada fio. Perguntar ao
 * paciente "para qual cuidador?" seria uma decisão a mais numa tela que o
 * §21 manda enxugar ao máximo.
 */
export async function broadcastPatientMessage(
  supabase: SupabaseClient,
  args: {
    patientId: string;
    clientMessageId: string;
    body: string;
    kind?: MessageKind;
    urgency?: UrgencyLevel;
  },
): Promise<Message[]> {
  const { data, error } = await supabase.rpc('broadcast_patient_message', {
    p_patient_id: args.patientId,
    p_client_message_id: args.clientMessageId,
    p_body: args.body,
    p_kind: args.kind ?? 'quick_phrase',
    p_urgency: args.urgency ?? 'normal',
  });
  if (error) throw toCommError(error);
  return Array.isArray(data) ? (data as Message[]) : [];
}

/**
 * Histórico, mais recentes primeiro, devolvido em ordem cronológica.
 *
 * A inversão acontece aqui e não na tela porque toda tela que mostra
 * conversa quer a mesma ordem, e esquecer o `.reverse()` em uma delas
 * produziria um histórico de cabeça para baixo em um lugar só.
 */
export async function fetchHistory(
  supabase: SupabaseClient,
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<Message[]> {
  let q = supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 50);

  if (opts.before) q = q.lt('created_at', opts.before);

  const { data, error } = await q;
  if (error) throw toCommError(error);
  return ((data ?? []) as Message[]).reverse();
}

/**
 * Mensagens criadas depois de um instante. É o catch-up da reconexão.
 *
 * `gt` e não `gte`: `since` é sempre o `created_at` de algo que já temos, e
 * `gte` traria essa mensagem de novo a cada reconexão.
 */
export async function fetchSince(
  supabase: SupabaseClient,
  conversationId: string,
  since: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .gt('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw toCommError(error);
  return (data ?? []) as Message[];
}

export async function markDelivered(
  supabase: SupabaseClient,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('mark_messages_delivered', {
    p_message_ids: messageIds,
  });
  if (error) throw toCommError(error);
  return typeof data === 'number' ? data : 0;
}

export async function markRead(
  supabase: SupabaseClient,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('mark_messages_read', {
    p_message_ids: messageIds,
  });
  if (error) throw toCommError(error);
  return typeof data === 'number' ? data : 0;
}

/** Lista de conversas do cuidador — a tela inicial do app (§10). */
export async function fetchConversations(
  supabase: SupabaseClient,
): Promise<CaregiverConversation[]> {
  const { data, error } = await supabase
    .from('v_caregiver_conversations')
    .select('*')
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (error) throw toCommError(error);
  return (data ?? []) as CaregiverConversation[];
}

/** Entrega e leitura de um conjunto de mensagens, para os "✓✓" do paciente. */
export async function fetchMessageStatus(
  supabase: SupabaseClient,
  messageIds: string[],
): Promise<MessageStatus[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await supabase
    .from('v_message_status')
    .select('*')
    .in('message_id', messageIds);

  if (error) throw toCommError(error);
  return (data ?? []) as MessageStatus[];
}

/**
 * Soft delete. O corpo é substituído, a linha permanece.
 *
 * Apagar a linha abriria buraco no fio e na auditoria; e num contexto
 * clínico, "esta mensagem foi apagada" é informação, enquanto o
 * desaparecimento silencioso não é.
 */
export async function deleteOwnMessage(
  supabase: SupabaseClient,
  messageId: string,
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ deleted_at: new Date().toISOString(), body: '[mensagem apagada]' })
    .eq('id', messageId);
  if (error) throw toCommError(error);
}

/**
 * Concilia mensagens vindas de fontes diferentes.
 *
 * O mesmo item chega pelo Realtime e pelo catch-up da reconexão — os dois
 * caminhos existem justamente porque nenhum sozinho é confiável. Deduplicar
 * por `id` e por `client_message_id` cobre também o eco local: a mensagem
 * que o próprio dispositivo acabou de enviar e que volta pelo Realtime.
 */
export function mergeMessages(atual: Message[], novas: Message[]): Message[] {
  const porId = new Map<string, Message>();
  const porClientId = new Map<string, string>();

  for (const m of [...atual, ...novas]) {
    const jaVisto = porClientId.get(m.client_message_id);
    if (jaVisto && jaVisto !== m.id) {
      // Mesmo client_message_id com id diferente só acontece em conversas
      // diferentes (broadcast). Dentro de um fio, o servidor garante um só.
      porId.set(m.id, m);
      continue;
    }
    porClientId.set(m.client_message_id, m.id);
    porId.set(m.id, m);
  }

  return [...porId.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

/** O RPC devolve a linha crua ou um array de um elemento, conforme o driver. */
function normalizarUm(data: unknown): Message {
  if (Array.isArray(data)) {
    const primeiro = data[0];
    if (!primeiro) throw toCommError({ message: 'resposta vazia do servidor' });
    return primeiro as Message;
  }
  if (!data) throw toCommError({ message: 'resposta vazia do servidor' });
  return data as Message;
}
