import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { CaregiverConversation } from '@irisflow/comm-client';

import { useSession } from './src/hooks/useSession';
import { comm, PREVIEW } from './src/lib/supabase';
import { attachPushHandlers, configureForegroundBehaviour } from './src/lib/notifications';
import { LoginScreen } from './src/screens/LoginScreen';
import { PatientsScreen } from './src/screens/PatientsScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { EmergencyScreen } from './src/screens/EmergencyScreen';
import { LinkPatientScreen } from './src/screens/LinkPatientScreen';
import { cores } from './src/lib/theme';

// Só existe em desenvolvimento; o bundle de produção nunca chega a avaliar
// este require porque PREVIEW é constante e falsa lá.
const PreviewBanner = PREVIEW
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ? (require('./src/preview/PreviewBanner') as typeof import('./src/preview/PreviewBanner')).PreviewBanner
  : null;

/**
 * Navegação por estado, sem biblioteca de rotas.
 *
 * São cinco telas com uma transição não convencional — a emergência entra
 * por cima de qualquer coisa, vinda de uma notificação, e não pode ser
 * dispensada por gesto de "voltar". Modelar isso num navigator daria mais
 * trabalho do que a máquina de estados abaixo, e o §21 vale também para o
 * app do cuidador: o caminho mais curto entre "chegou o alerta" e "estou
 * indo" é o que importa.
 */
type Tela =
  | { nome: 'pacientes' }
  | { nome: 'conversa'; conversa: CaregiverConversation }
  | { nome: 'vincular' }
  | { nome: 'emergencia'; alertId: string; patientId: string; patientName: string };

configureForegroundBehaviour();

export default function App() {
  const { session, carregando } = useSession();
  const [tela, setTela] = useState<Tela>({ nome: 'pacientes' });
  const [recarregar, setRecarregar] = useState(0);

  // Tocar na notificação leva direto ao destino. Uma emergência que abrisse a
  // lista de pacientes e exigisse mais um toque estaria cobrando um passo
  // exatamente no instante em que ele custa mais caro.
  useEffect(() => {
    if (!comm || !session) return;
    return attachPushHandlers(comm.supabase, {
      onEmergency: (alertId, patientId) =>
        setTela({ nome: 'emergencia', alertId, patientId, patientName: 'Paciente' }),
      onMessage: () => setTela({ nome: 'pacientes' }),
    });
  }, [session]);

  if (carregando) {
    return (
      <View style={s.centro}>
        <ActivityIndicator size="large" color={cores.primaria} />
      </View>
    );
  }

  if (!session) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <SafeAreaView style={s.raiz}>
          <LoginScreen />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  // A emergência ocupa a tela inteira, sem área segura clara e sem barra:
  // é vermelha de ponta a ponta, de propósito.
  if (tela.nome === 'emergencia') {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView style={s.raizEmergencia} edges={['top', 'bottom']}>
          <EmergencyScreen
            alertId={tela.alertId}
            patientId={tela.patientId}
            patientName={tela.patientName}
            onFechar={() => {
              setRecarregar((n) => n + 1);
              setTela({ nome: 'pacientes' });
            }}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={s.raiz} edges={['top']}>
        {PreviewBanner && (
          <PreviewBanner
            onEmergencia={(alertId, patientId, patientName) =>
              setTela({ nome: 'emergencia', alertId, patientId, patientName })
            }
          />
        )}

        {tela.nome === 'pacientes' && (
          <PatientsScreen
            key={recarregar}
            onAbrirConversa={(conversa) => setTela({ nome: 'conversa', conversa })}
            onAbrirAlerta={(alertId, patientId, patientName) =>
              setTela({ nome: 'emergencia', alertId, patientId, patientName })
            }
            onVincular={() => setTela({ nome: 'vincular' })}
          />
        )}

        {tela.nome === 'conversa' && (
          <ConversationScreen
            conversa={tela.conversa}
            onVoltar={() => {
              setRecarregar((n) => n + 1);
              setTela({ nome: 'pacientes' });
            }}
          />
        )}

        {tela.nome === 'vincular' && (
          <LinkPatientScreen
            onVinculado={() => {
              setRecarregar((n) => n + 1);
              setTela({ nome: 'pacientes' });
            }}
            onCancelar={() => setTela({ nome: 'pacientes' })}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  raiz: { flex: 1, backgroundColor: cores.fundo },
  raizEmergencia: { flex: 1, backgroundColor: cores.emergencia },
  centro: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: cores.fundo,
  },
});
