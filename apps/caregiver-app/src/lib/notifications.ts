/**
 * Notificações push.
 *
 * Duas regras governam este arquivo:
 *
 *  1. Nada é simulado (§8). Sem permissão concedida ou sem projeto EAS
 *     configurado, `registerForPush` devolve o motivo e o app EXIBE isso.
 *     Um app que diz "notificações ativas" sem ter token registrado é pior
 *     que um que admite não ter — o cuidador dorme achando que será acordado.
 *
 *  2. Receber a notificação não é confirmar a entrega. O handler chama
 *     `mark_emergency_delivered` — é o código rodando NESTE aparelho que
 *     sabe que o alerta chegou, não o serviço de push que aceitou o ticket.
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import { markEmergencyDelivered } from '@irisflow/comm-client';

export type PushStatus =
  | { ok: true; token: string; criticalOk: boolean }
  | { ok: false; reason: string; hint: string };

/**
 * Canais do Android.
 *
 * Três, não um. O Android aplica importância, som e bypass do "Não
 * perturbe" por canal, e o usuário pode ajustar cada um separadamente — que
 * é o ponto: alguém pode querer silenciar "mensagens" às 3 da manhã sem
 * silenciar "emergência". Um canal único obrigaria a escolher entre ser
 * incomodado por tudo ou por nada.
 */
export async function setupAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('mensagens', {
    name: 'Mensagens',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250],
    lightColor: '#1B54A8',
  });

  await Notifications.setNotificationChannelAsync('urgente', {
    name: 'Pedidos urgentes',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 400, 200, 400],
    lightColor: '#F59E0B',
    sound: 'default',
  });

  await Notifications.setNotificationChannelAsync('emergencia', {
    name: 'Emergência',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 600, 300, 600, 300, 600],
    lightColor: '#DC2626',
    sound: 'default',
    // Sem isto, o alerta silencia junto com o resto quando o celular está no
    // "Não perturbe" — exatamente a situação noturna em que ele mais importa.
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/** Registra o token. Devolve o motivo quando não dá — nunca finge sucesso. */
export async function registerForPush(supabase: SupabaseClient): Promise<PushStatus> {
  if (!Device.isDevice) {
    return {
      ok: false,
      reason: 'Emulador não recebe notificações push.',
      hint: 'Teste os alertas em um aparelho físico.',
    };
  }

  await setupAndroidChannels();

  const { status: atual } = await Notifications.getPermissionsAsync();
  let status = atual;
  if (status !== 'granted') {
    const pedido = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowSound: true,
        allowBadge: true,
        // Fura o modo Foco sem exigir o entitlement de alerta crítico.
        allowProvisional: false,
      },
    });
    status = pedido.status;
  }

  if (status !== 'granted') {
    return {
      ok: false,
      reason: 'Permissão de notificações negada.',
      hint: 'Ative em Ajustes > IrisFlow Cuidador > Notificações. Sem isso, '
        + 'você não será avisado quando o app estiver fechado.',
    };
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;

  if (!projectId) {
    return {
      ok: false,
      reason: 'Projeto EAS não configurado.',
      hint: 'Rode `eas init` no app. Sem projectId o Expo não emite token de push.',
    };
  }

  let token: string;
  try {
    const r = await Notifications.getExpoPushTokenAsync({ projectId });
    token = r.data;
  } catch (err) {
    return {
      ok: false,
      reason: 'Não foi possível obter o token de push.',
      hint: err instanceof Error ? err.message : 'Verifique as credenciais de FCM/APNs.',
    };
  }

  // Alerta crítico exige entitlement da Apple, concedido caso a caso. Sem
  // ele, o push-fanout degrada para time-sensitive — e a tela de status
  // mostra que o nível crítico não está ativo, em vez de deixar supor.
  const criticalOk = Platform.OS === 'ios'
    ? Boolean(
        (Constants.expoConfig?.ios?.entitlements ?? {})[
          'com.apple.developer.usernotifications.critical-alerts'
        ],
      )
    : true;

  const { error } = await supabase.rpc('register_push_token', {
    p_token: token,
    p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
    p_device: Device.modelName ?? null,
    p_critical_ok: criticalOk,
  });

  if (error) {
    return {
      ok: false,
      reason: 'Falha ao registrar o token no servidor.',
      hint: error.message,
    };
  }

  return { ok: true, token, criticalOk };
}

/**
 * Como a notificação se comporta com o app ABERTO.
 *
 * Emergência continua tocando e vibrando mesmo em primeiro plano: o cuidador
 * pode estar com o app aberto em outra tela, e o silêncio faria o alerta
 * passar despercebido. Mensagem comum não faz barulho — a conversa já está
 * na frente dele.
 */
export function configureForegroundBehaviour(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const urgencia = (n.request.content.data?.urgency ?? 'normal') as string;
      const emergencia =
        n.request.content.data?.tipo === 'emergencia' || urgencia === 'emergencia';

      return {
        // `shouldShowAlert` é o campo do SDK 52; `shouldShowBanner`/
        // `shouldShowList` são o par que o substitui a partir do 53. Manter
        // os três mantém o comportamento correto na atualização, e o custo é
        // uma linha — barato demais para arriscar a notificação de
        // emergência parar de aparecer numa troca de versão.
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: emergencia || urgencia === 'urgente',
        shouldSetBadge: true,
      };
    },
  });
}

export interface PushHandlers {
  onEmergency: (alertId: string, patientId: string) => void;
  onMessage: (conversationId: string, patientId: string) => void;
}

/**
 * Escuta as notificações e CONFIRMA a entrega dos alertas.
 *
 * A chamada a `markEmergencyDelivered` aqui é o que torna `ENTREGUE` um
 * fato: este código só roda porque a notificação efetivamente chegou ao
 * aparelho. É a diferença entre "o Expo aceitou" e "o cuidador recebeu".
 */
export function attachPushHandlers(
  supabase: SupabaseClient,
  handlers: PushHandlers,
): () => void {
  const receber = Notifications.addNotificationReceivedListener((n) => {
    const d = n.request.content.data as Record<string, string> | undefined;
    if (d?.tipo === 'emergencia' && d.alert_id) {
      void markEmergencyDelivered(supabase, d.alert_id).catch(() => {
        // Sem rede no momento do recebimento. A tela de emergência tenta de
        // novo quando abrir; o estado no servidor continua honesto até lá.
      });
    }
  });

  const tocar = Notifications.addNotificationResponseReceivedListener((r) => {
    const d = r.notification.request.content.data as Record<string, string> | undefined;
    if (!d) return;
    if (d.tipo === 'emergencia' && d.alert_id && d.patient_id) {
      handlers.onEmergency(d.alert_id, d.patient_id);
    } else if (d.tipo === 'mensagem' && d.conversation_id && d.patient_id) {
      handlers.onMessage(d.conversation_id, d.patient_id);
    }
  });

  return () => {
    receber.remove();
    tocar.remove();
  };
}
