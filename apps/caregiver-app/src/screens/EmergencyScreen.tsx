import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, Vibration, View,
} from 'react-native';
import {
  acknowledgeEmergency, markEmergencySeen, subscribeToPatientAlerts,
  type EmergencyAlert,
} from '@irisflow/comm-client';
import { requireComm } from '../lib/supabase';
import { ALVO_MIN, cores, espaco, horaCurta, raio } from '../lib/theme';

interface Props {
  alertId: string;
  patientId: string;
  patientName: string;
  onFechar: () => void;
}

/**
 * Tela de emergência (§20).
 *
 * Tela cheia, vermelha, um botão. Nada mais: qualquer elemento adicional
 * compete com a única ação que importa nos próximos segundos.
 *
 * Ao montar, registra VISUALIZADO. Ao tocar no botão, CONFIRMADO — que é o
 * que o paciente vê como "Seu cuidador confirmou. Está vindo." A separação
 * entre os dois não é burocracia: "eu vi a tela" e "eu assumi e estou indo"
 * são fatos diferentes, e o escalonamento continua enquanto só o primeiro
 * tiver acontecido.
 */
export const EmergencyScreen: React.FC<Props> = ({
  alertId, patientId, patientName, onFechar,
}) => {
  const comm = requireComm();
  const [alerta, setAlerta] = useState<EmergencyAlert | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    // Vibração contínua: o cuidador pode estar com o telefone no bolso.
    // Padrão longo e repetido, distinto de qualquer notificação comum.
    Vibration.vibrate([0, 600, 300, 600, 300], true);
    return () => Vibration.cancel();
  }, []);

  useEffect(() => {
    let vivo = true;
    void markEmergencySeen(comm.supabase, alertId)
      .then((a) => vivo && setAlerta(a))
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : 'Falha ao abrir.'));
    return () => { vivo = false; };
  }, [comm, alertId]);

  // O paciente pode cancelar do lado dele; a tela precisa refletir isso na
  // hora, e não deixar o cuidador correndo por um alerta já encerrado.
  useEffect(() => {
    const sub = subscribeToPatientAlerts(comm.supabase, patientId, (a) => {
      if (a.id === alertId) setAlerta(a);
    });
    return () => { void sub.unsubscribe(); };
  }, [comm, patientId, alertId]);

  async function confirmar() {
    setConfirmando(true);
    setErro(null);
    try {
      const a = await acknowledgeEmergency(comm.supabase, alertId);
      setAlerta(a);
      Vibration.cancel();
    } catch (e) {
      // Sem rede, a confirmação NÃO acontece — e a tela diz isso, em vez de
      // mostrar um "confirmado" que o paciente nunca vai receber.
      setErro(
        e instanceof Error && e.message.includes('cancelado')
          ? 'O paciente cancelou este alerta.'
          : 'Não foi possível confirmar. Verifique sua conexão e tente de novo.',
      );
    } finally {
      setConfirmando(false);
    }
  }

  const confirmado = alerta?.state === 'CONFIRMADO';
  const cancelado = alerta?.state === 'CANCELADO';

  if (cancelado) {
    return (
      <View style={[s.tela, s.telaNeutra]}>
        <Text style={s.tituloNeutro}>Alerta cancelado</Text>
        <Text style={s.subNeutro}>
          {patientName} cancelou o pedido de socorro.
        </Text>
        <Pressable style={s.botaoNeutro} onPress={onFechar} accessibilityRole="button">
          <Text style={s.botaoNeutroTexto}>Voltar</Text>
        </Pressable>
      </View>
    );
  }

  if (confirmado) {
    return (
      <View style={[s.tela, s.telaConfirmada]}>
        <Text style={s.selo}>✓ CONFIRMADO</Text>
        <Text style={s.nome}>{patientName}</Text>
        <Text style={s.subConfirmado}>
          {patientName} já foi avisado de que você está indo.
        </Text>
        {alerta?.acknowledged_at && (
          <Text style={s.horaConfirmada}>
            Confirmado às {horaCurta(alerta.acknowledged_at)}
          </Text>
        )}
        <Pressable style={s.botaoBranco} onPress={onFechar} accessibilityRole="button">
          <Text style={s.botaoBrancoTexto}>Abrir conversa</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.tela} accessibilityLiveRegion="assertive">
      <Text style={s.selo}>🚨 EMERGÊNCIA</Text>
      <Text style={s.nome}>{patientName}</Text>
      <Text style={s.categoria}>{descreverCategoria(alerta?.category)}</Text>

      {alerta?.triggered_at && (
        <Text style={s.hora}>Acionado às {horaCurta(alerta.triggered_at)}</Text>
      )}

      {erro && <Text style={s.erro}>{erro}</Text>}

      <View style={s.rodape}>
        <Pressable
          style={s.botaoConfirmar}
          onPress={() => void confirmar()}
          disabled={confirmando}
          accessibilityRole="button"
          accessibilityLabel="Recebi, estou indo"
        >
          {confirmando
            ? <ActivityIndicator color={cores.emergencia} />
            : <Text style={s.botaoConfirmarTexto}>RECEBI, ESTOU INDO</Text>}
        </Pressable>

        <Text style={s.nota}>
          Confirmar avisa {patientName} de que alguém está a caminho.
        </Text>
      </View>
    </View>
  );
};

function descreverCategoria(c: string | undefined): string {
  switch (c) {
    case 'pain': return 'Dor';
    case 'breath': return 'Falta de ar';
    case 'cold': return 'Frio';
    default: return 'Precisa de ajuda';
  }
}

const s = StyleSheet.create({
  tela: {
    flex: 1, backgroundColor: cores.emergencia,
    padding: espaco.lg, paddingTop: espaco.xl * 2,
  },
  telaConfirmada: { backgroundColor: cores.sucesso },
  telaNeutra: {
    backgroundColor: cores.fundo, alignItems: 'center', justifyContent: 'center',
  },
  selo: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 1.5 },
  nome: { color: '#fff', fontSize: 42, fontWeight: '800', marginTop: espaco.sm },
  categoria: { color: '#FEE2E2', fontSize: 24, fontWeight: '600', marginTop: espaco.xs },
  hora: { color: '#FECACA', fontSize: 15, marginTop: espaco.md },
  erro: {
    color: '#fff', fontSize: 15, fontWeight: '700', marginTop: espaco.md,
    backgroundColor: 'rgba(0,0,0,0.25)', padding: espaco.md, borderRadius: raio.sm,
  },
  rodape: { marginTop: 'auto' },
  botaoConfirmar: {
    backgroundColor: '#fff', borderRadius: raio.lg, minHeight: 80,
    alignItems: 'center', justifyContent: 'center',
  },
  botaoConfirmarTexto: { color: cores.emergencia, fontSize: 22, fontWeight: '800' },
  nota: {
    color: '#FECACA', fontSize: 14, textAlign: 'center',
    marginTop: espaco.md, marginBottom: espaco.lg,
  },
  subConfirmado: { color: '#D1FAE5', fontSize: 18, marginTop: espaco.md, lineHeight: 26 },
  horaConfirmada: { color: '#A7F3D0', fontSize: 15, marginTop: espaco.sm },
  botaoBranco: {
    backgroundColor: '#fff', borderRadius: raio.md, minHeight: ALVO_MIN + 8,
    alignItems: 'center', justifyContent: 'center', marginTop: 'auto',
    marginBottom: espaco.lg,
  },
  botaoBrancoTexto: { color: cores.sucesso, fontSize: 18, fontWeight: '700' },
  tituloNeutro: { fontSize: 24, fontWeight: '700', color: cores.texto },
  subNeutro: {
    fontSize: 16, color: cores.textoFraco, marginTop: espaco.sm,
    textAlign: 'center', paddingHorizontal: espaco.lg,
  },
  botaoNeutro: {
    backgroundColor: cores.primaria, borderRadius: raio.md, minHeight: ALVO_MIN,
    paddingHorizontal: espaco.xl, alignItems: 'center', justifyContent: 'center',
    marginTop: espaco.lg,
  },
  botaoNeutroTexto: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
