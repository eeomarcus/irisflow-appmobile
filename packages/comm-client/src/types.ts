/**
 * Tipos do canal de comunicação. Espelham o schema em
 * `supabase/migrations/0001_comunicacao_core.sql`.
 *
 * Ao alterar um enum aqui, altere o `create type` correspondente. Os dois
 * lados são a mesma verdade escrita duas vezes; divergir é o começo de um
 * bug de produção difícil de enxergar.
 */

export type UrgencyLevel = 'normal' | 'importante' | 'urgente' | 'emergencia';

export type MessageKind = 'text' | 'quick_phrase' | 'yes' | 'no' | 'request' | 'system';

export type SenderKind = 'patient' | 'caregiver' | 'system';

export type CareRole = 'primary' | 'secondary' | 'professional';

export type CareLinkStatus = 'pending' | 'active' | 'revoked';

/**
 * Estados do alerta de emergência (§4 do briefing).
 *
 * `ENVIANDO` existe só no cliente — é o intervalo entre o paciente acionar e
 * o servidor confirmar. Não há linha no banco nesse estado, e isso é
 * proposital: a linha existir já significa que o servidor recebeu.
 */
export type EmergencyState =
  | 'ENVIANDO'
  | 'ALERTA_DISPARADO'
  | 'ENTREGUE'
  | 'VISUALIZADO'
  | 'CONFIRMADO'
  | 'CANCELADO'
  | 'FALHA_DE_ENVIO';

/** Estados que o servidor conhece. `ENVIANDO` fica de fora por construção. */
export type ServerEmergencyState = Exclude<EmergencyState, 'ENVIANDO'>;

export type EmergencyCategory = 'pain' | 'breath' | 'cold' | 'other';

export interface Message {
  id: string;
  conversation_id: string;
  client_message_id: string;
  sender_kind: SenderKind;
  sender_user_id: string | null;
  kind: MessageKind;
  urgency: UrgencyLevel;
  body: string;
  created_at: string;
  server_received_at: string;
  deleted_at: string | null;
}

export interface MessageReceipt {
  message_id: string;
  recipient_user_id: string;
  delivered_at: string | null;
  read_at: string | null;
}

export interface EmergencyAlert {
  id: string;
  patient_id: string;
  client_alert_id: string;
  category: EmergencyCategory;
  state: ServerEmergencyState;
  note: string | null;
  triggered_at: string;
  delivered_at: string | null;
  seen_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  escalation_level: number;
}

export interface CaregiverConversation {
  conversation_id: string;
  patient_id: string;
  caregiver_user_id: string;
  patient_name: string;
  last_message_at: string | null;
  patient_status: 'online' | 'offline' | 'unknown';
  irisflow_running: boolean;
  last_seen_at: string | null;
  last_message_body: string | null;
  last_message_sender: SenderKind | null;
  last_message_urgency: UrgencyLevel | null;
  unread_count: number;
  active_alert_id: string | null;
  active_alert_state: ServerEmergencyState | null;
  active_alert_at: string | null;
}

/** Situação de entrega de uma mensagem, agregada entre os destinatários. */
export interface MessageStatus {
  message_id: string;
  conversation_id: string;
  client_message_id: string;
  created_at: string;
  server_received_at: string;
  delivered_count: number;
  read_count: number;
  first_delivered_at: string | null;
  first_read_at: string | null;
}

/**
 * Estado de um item na fila de saída.
 *
 * `sent` só é atingido com resposta do servidor. É o invariante que faz a
 * interface parar de mentir (§13): nada exibe "enviado" a partir de `queued`
 * ou `sending`.
 */
export type OutboxState = 'queued' | 'sending' | 'sent' | 'failed';

export interface OutboxItem {
  /** UUID gerado no cliente. Chave de idempotência ponta a ponta. */
  clientId: string;
  conversationId: string | null;
  /** Preenchido quando o destino é o broadcast para todos os cuidadores. */
  patientId: string | null;
  body: string;
  kind: MessageKind;
  urgency: UrgencyLevel;
  state: OutboxState;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** Preenchido quando o servidor confirma. */
  serverId: string | null;
}

/**
 * Armazenamento persistente, injetado.
 *
 * `localStorage` no Electron, `AsyncStorage` no Expo, `Map` nos testes. O
 * outbox não pode importar nenhum dos três: importar `localStorage` quebraria
 * no React Native, e importar `AsyncStorage` quebraria no Electron.
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface CommConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  storage: StorageAdapter;
  /** Injetável para o teste controlar o relógio. */
  now?: () => number;
}
