/**
 * @irisflow/comm-client
 *
 * Camada de comunicação paciente <-> cuidador, compartilhada entre o
 * IrisFlow desktop (Electron) e o app do cuidador (Expo).
 *
 * Este pacote não importa nada do pipeline de rastreamento ocular, e isso é
 * uma fronteira estrutural, não uma convenção: frames, landmarks e vetores
 * de calibração não têm como chegar à rede a partir daqui (§12, §17).
 */

export * from './types';

export {
  createCommClient,
  isCommConfigured,
  memoryStorage,
  webStorage,
  newClientId,
  CommError,
  toCommError,
  AVISO_SEM_CONFIG,
  type CommClient,
} from './client';

export { Outbox, type Sender, type SendResult, type OutboxOptions, type OutboxEvents } from './outbox';

export {
  sendMessage,
  broadcastPatientMessage,
  fetchHistory,
  fetchSince,
  fetchConversations,
  fetchMessageStatus,
  markDelivered,
  markRead,
  deleteOwnMessage,
  mergeMessages,
  type SendMessageArgs,
} from './messages';

export {
  EmergencyController,
  triggerEmergency,
  markEmergencyDelivered,
  markEmergencySeen,
  acknowledgeEmergency,
  cancelEmergency,
  failEmergency,
  fetchActiveAlert,
  canTransition,
  isUnresolved,
  describeState,
  type StateDescription,
  type TriggerArgs,
  type EmergencyControllerOptions,
} from './emergency';

export {
  subscribeToConversation,
  subscribeToPatientAlerts,
  startPresenceHeartbeat,
  type ConversationSubscription,
  type SubscribeArgs,
} from './realtime';

export {
  QUICK_PHRASES,
  CAREGIVER_QUICK_REPLIES,
  urgencyOf,
  findPhrase,
  type QuickPhrase,
} from './phrases';
