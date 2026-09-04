import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl,
  StyleSheet, Text, View,
} from 'react-native';
import {
  fetchConversations, subscribeToPatientAlerts,
  type CaregiverConversation,
} from '@irisflow/comm-client';
import { requireComm } from '../lib/supabase';
import { registerForPush, type PushStatus } from '../lib/notifications';
import { sair } from '../hooks/useSession';
import { ALVO_MIN, cores, espaco, estiloDaUrgencia, horaRelativa, raio } from '../lib/theme';

interface Props {
  onAbrirConversa: (c: CaregiverConversation) => void;
  onAbrirAlerta: (alertId: string, patientId: string, nome: string) => void;
  onVincular: () => void;
}

/**
 * Tela inicial (§10): pacientes, status, última mensagem, alertas.
 *
 * Um paciente com alerta ativo sobe para o topo e vira um cartão vermelho de
 * largura inteira. É a única quebra de hierarquia da tela, e existe porque
 * uma emergência competindo em pé de igualdade com "Estou com sede" na mesma
 * lista é um erro de design com consequência física.
 */
export const PatientsScreen: React.FC<Props> = ({
  onAbrirConversa, onAbrirAlerta, onVincular,
}) => {
  const comm = requireComm();
  const [itens, setItens] = useState<CaregiverConversation[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await fetchConversations(comm.supabase);
      // Alerta não resolvido primeiro; depois por atividade recente.
      r.sort((a, b) => {
        if (Boolean(a.active_alert_id) !== Boolean(b.active_alert_id)) {
          return a.active_alert_id ? -1 : 1;
        }
        return (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '');
      });
      setItens(r);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao carregar.');
    } finally {
      setCarregando(false);
      setAtualizando(false);
    }
  }, [comm]);

  useEffect(() => {
    void carregar();
    void registerForPush(comm.supabase).then(setPush);
  }, [carregar, comm]);

  // Um canal por paciente. Um alerta precisa aparecer aqui mesmo com a
  // conversa daquele paciente fechada — é o caso mais provável, aliás.
  useEffect(() => {
    const subs = itens.map((i) =>
      subscribeToPatientAlerts(comm.supabase, i.patient_id, () => void carregar()),
    );
    return () => {
      for (const s of subs) void s.unsubscribe();
    };
  }, [itens.map((i) => i.patient_id).join(','), comm, carregar]);

  if (carregando) {
    return (
      <View style={[s.tela, s.centro]}>
        <ActivityIndicator size="large" color={cores.primaria} />
      </View>
    );
  }

  return (
    <View style={s.tela}>
      <View style={s.cabecalho}>
        <Text style={s.titulo}>Meus pacientes</Text>
        <Pressable onPress={() => void sair()} style={s.sair} accessibilityRole="button">
          <Text style={s.sairTexto}>Sair</Text>
        </Pressable>
      </View>

      {/* Status honesto do push (§8). Se o cuidador não vai ser acordado, ele
          precisa saber disso ANTES da noite em que isso importar. */}
      {push && !push.ok && (
        <View style={s.faixaAviso}>
          <Text style={s.faixaTitulo}>⚠ {push.reason}</Text>
          <Text style={s.faixaTexto}>{push.hint}</Text>
        </View>
      )}
      {push?.ok && !push.criticalOk && (
        <View style={s.faixaInfo}>
          <Text style={s.faixaTexto}>
            Alertas chegam como “sensíveis ao tempo”. O nível crítico, que toca
            mesmo no silencioso, ainda não está liberado pela Apple.
          </Text>
        </View>
      )}
      {erro && <Text style={s.erro}>{erro}</Text>}

      <FlatList
        data={itens}
        keyExtractor={(i) => i.conversation_id}
        contentContainerStyle={s.lista}
        refreshControl={
          <RefreshControl
            refreshing={atualizando}
            onRefresh={() => {
              setAtualizando(true);
              void carregar();
            }}
          />
        }
        ListEmptyComponent={
          <View style={s.vazio}>
            <Text style={s.vazioTitulo}>Nenhum paciente vinculado</Text>
            <Text style={s.vazioTexto}>
              Peça o código de vínculo de 8 letras no IrisFlow do paciente e
              use o botão abaixo.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <CartaoPaciente
            item={item}
            onAbrirConversa={() => onAbrirConversa(item)}
            onAbrirAlerta={() =>
              item.active_alert_id &&
              onAbrirAlerta(item.active_alert_id, item.patient_id, item.patient_name)
            }
          />
        )}
      />

      <Pressable style={s.botaoVincular} onPress={onVincular} accessibilityRole="button">
        <Text style={s.botaoVincularTexto}>+ Vincular paciente</Text>
      </Pressable>
    </View>
  );
};

const CartaoPaciente: React.FC<{
  item: CaregiverConversation;
  onAbrirConversa: () => void;
  onAbrirAlerta: () => void;
}> = ({ item, onAbrirConversa, onAbrirAlerta }) => {
  if (item.active_alert_id) {
    return (
      <Pressable
        style={s.cartaoAlerta}
        onPress={onAbrirAlerta}
        accessibilityRole="button"
        accessibilityLabel={`Emergência de ${item.patient_name}. Toque para abrir.`}
      >
        <Text style={s.alertaSelo}>🚨 EMERGÊNCIA</Text>
        <Text style={s.alertaNome}>{item.patient_name}</Text>
        <Text style={s.alertaHora}>
          Acionado {horaRelativa(item.active_alert_at)}
          {item.active_alert_state === 'ENTREGUE' && ' · recebido'}
          {item.active_alert_state === 'VISUALIZADO' && ' · você já viu'}
        </Text>
        <View style={s.alertaAcao}>
          <Text style={s.alertaAcaoTexto}>ABRIR E CONFIRMAR</Text>
        </View>
      </Pressable>
    );
  }

  const online = item.patient_status === 'online';
  const urg = item.last_message_urgency ?? 'normal';
  const estilo = estiloDaUrgencia(urg);

  return (
    <Pressable
      style={s.cartao}
      onPress={onAbrirConversa}
      accessibilityRole="button"
      accessibilityLabel={`Conversa com ${item.patient_name}, ${item.unread_count} não lidas`}
    >
      <View style={s.linhaTopo}>
        <Text style={s.nome}>{item.patient_name}</Text>
        {item.unread_count > 0 && (
          <View style={s.selo}>
            <Text style={s.seloTexto}>{item.unread_count}</Text>
          </View>
        )}
      </View>

      <View style={s.linhaStatus}>
        <View style={[s.ponto, { backgroundColor: online ? cores.online : cores.offline }]} />
        <Text style={s.status}>
          {online
            ? (item.irisflow_running ? 'Online · IrisFlow aberto' : 'Online')
            : `Offline · visto ${horaRelativa(item.last_seen_at) || 'há muito tempo'}`}
        </Text>
      </View>

      {item.last_message_body && (
        <Text
          style={[s.previa, { color: estilo.cor, fontWeight: estilo.peso }]}
          numberOfLines={2}
        >
          {item.last_message_sender === 'caregiver' ? 'Você: ' : ''}
          {item.last_message_body}
        </Text>
      )}

      <View style={s.linhaRodape}>
        {estilo.rotulo ? (
          <Text style={[s.tag, { color: estilo.cor }]}>{estilo.rotulo}</Text>
        ) : <View />}
        <Text style={s.hora}>{horaRelativa(item.last_message_at)}</Text>
      </View>
    </Pressable>
  );
};

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  centro: { justifyContent: 'center', alignItems: 'center' },
  cabecalho: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: espaco.md, paddingTop: espaco.md, paddingBottom: espaco.sm,
  },
  titulo: { fontSize: 26, fontWeight: '800', color: cores.texto },
  sair: {
    minHeight: ALVO_MIN, minWidth: ALVO_MIN,
    alignItems: 'flex-end', justifyContent: 'center',
  },
  sairTexto: { color: cores.primaria, fontSize: 15, fontWeight: '600' },

  faixaAviso: {
    backgroundColor: '#FFFBEB', borderLeftWidth: 4, borderLeftColor: cores.urgente,
    padding: espaco.md, marginHorizontal: espaco.md, borderRadius: raio.sm,
    marginBottom: espaco.sm,
  },
  faixaInfo: {
    backgroundColor: cores.primariaFraca, padding: espaco.md,
    marginHorizontal: espaco.md, borderRadius: raio.sm, marginBottom: espaco.sm,
  },
  faixaTitulo: { fontWeight: '700', color: cores.texto, marginBottom: 2 },
  faixaTexto: { color: cores.textoFraco, fontSize: 13, lineHeight: 19 },
  erro: { color: cores.erro, paddingHorizontal: espaco.md, paddingBottom: espaco.sm },

  lista: { padding: espaco.md, paddingBottom: 100 },

  cartao: {
    backgroundColor: cores.cartao, borderRadius: raio.lg, padding: espaco.md,
    marginBottom: espaco.md, borderWidth: 1, borderColor: cores.borda,
  },
  linhaTopo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nome: { fontSize: 19, fontWeight: '700', color: cores.texto, flex: 1 },
  selo: {
    backgroundColor: cores.primaria, borderRadius: raio.pill,
    minWidth: 26, height: 26, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 7,
  },
  seloTexto: { color: '#fff', fontWeight: '800', fontSize: 13 },
  linhaStatus: { flexDirection: 'row', alignItems: 'center', marginTop: espaco.xs },
  ponto: { width: 8, height: 8, borderRadius: 4, marginRight: espaco.xs },
  status: { fontSize: 13, color: cores.textoFraco },
  previa: { fontSize: 15, marginTop: espaco.sm, lineHeight: 21 },
  linhaRodape: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: espaco.sm,
  },
  tag: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  hora: { fontSize: 12, color: cores.textoFraco },

  cartaoAlerta: {
    backgroundColor: cores.emergencia, borderRadius: raio.lg,
    padding: espaco.lg, marginBottom: espaco.md,
  },
  alertaSelo: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  alertaNome: { color: '#fff', fontSize: 26, fontWeight: '800', marginTop: espaco.xs },
  alertaHora: { color: '#FEE2E2', fontSize: 14, marginTop: espaco.xs },
  alertaAcao: {
    backgroundColor: '#fff', borderRadius: raio.md, minHeight: ALVO_MIN,
    alignItems: 'center', justifyContent: 'center', marginTop: espaco.md,
  },
  alertaAcaoTexto: { color: cores.emergencia, fontWeight: '800', fontSize: 16 },

  vazio: { padding: espaco.xl, alignItems: 'center' },
  vazioTitulo: { fontSize: 18, fontWeight: '700', color: cores.texto, marginBottom: espaco.sm },
  vazioTexto: { fontSize: 15, color: cores.textoFraco, textAlign: 'center', lineHeight: 22 },

  botaoVincular: {
    position: 'absolute', left: espaco.md, right: espaco.md, bottom: espaco.lg,
    minHeight: ALVO_MIN + 6, backgroundColor: cores.primaria, borderRadius: raio.md,
    alignItems: 'center', justifyContent: 'center',
  },
  botaoVincularTexto: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
