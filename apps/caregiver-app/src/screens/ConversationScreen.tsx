import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  CAREGIVER_QUICK_REPLIES, Outbox, fetchHistory, fetchSince, markRead,
  memoryStorage, mergeMessages, newClientId, sendMessage, subscribeToConversation,
  type CaregiverConversation, type Message, type OutboxItem,
} from '@irisflow/comm-client';
import { requireComm } from '../lib/supabase';
import { ALVO_MIN, cores, espaco, horaCurta, raio } from '../lib/theme';

interface Props {
  conversa: CaregiverConversation;
  onVoltar: () => void;
}

type Conexao = 'connected' | 'reconnecting' | 'error';

/**
 * Tela de conversa (§10).
 *
 * O ponto que separa esta tela de um chat comum: o balão do cuidador mostra
 * o estado real do envio, vindo do outbox. Enquanto o servidor não confirma,
 * lê-se "enviando…". Um "✓" otimista aqui é a mesma mentira que o §13
 * proíbe na emergência — só que numa conversa em que o paciente pode estar
 * esperando resposta para saber se alguém vem.
 */
export const ConversationScreen: React.FC<Props> = ({ conversa, onVoltar }) => {
  const comm = requireComm();
  const [mensagens, setMensagens] = useState<Message[]>([]);
  const [saida, setSaida] = useState<readonly OutboxItem[]>([]);
  const [texto, setTexto] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [conexao, setConexao] = useState<Conexao>('reconnecting');
  const lista = useRef<FlatList<Message>>(null);

  // Outbox em memória: a conversa está aberta, e uma mensagem do cuidador que
  // não sai agora ele vai simplesmente reescrever. Persistir aqui adicionaria
  // complexidade sem resolver um problema real — diferente do lado do
  // paciente, onde a mensagem custa esforço para compor pelo olhar.
  const outbox = useRef(
    new Outbox({
      storage: memoryStorage(),
      send: async (item) => {
        const m = await sendMessage(comm.supabase, {
          conversationId: conversa.conversation_id,
          clientMessageId: item.clientId,
          body: item.body,
          kind: item.kind,
          urgency: item.urgency,
        });
        setMensagens((atual) => mergeMessages(atual, [m]));
        return { serverId: m.id };
      },
      events: { onChange: setSaida },
    }),
  ).current;

  const marcarLidas = useCallback(
    async (lote: Message[]) => {
      const ids = lote.filter((m) => m.sender_kind === 'patient').map((m) => m.id);
      if (ids.length) await markRead(comm.supabase, ids).catch(() => {});
    },
    [comm],
  );

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const h = await fetchHistory(comm.supabase, conversa.conversation_id, { limit: 80 });
        if (!vivo) return;
        setMensagens(h);
        void marcarLidas(h);
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => { vivo = false; };
  }, [comm, conversa.conversation_id, marcarLidas]);

  useEffect(() => {
    const sub = subscribeToConversation(comm.supabase, {
      conversationId: conversa.conversation_id,
      patientId: conversa.patient_id,
      onMessage: (m) => {
        setMensagens((atual) => mergeMessages(atual, [m]));
        if (m.sender_kind === 'patient') void marcarLidas([m]);
      },
      onStatus: setConexao,
      // Reconectar não é estar em dia: sem este passo, o que chegou durante a
      // troca de rede nunca apareceria, e ninguém saberia que faltou.
      onCatchUp: async (desde) => {
        if (!desde) return;
        const novas = await fetchSince(comm.supabase, conversa.conversation_id, desde)
          .catch(() => [] as Message[]);
        if (novas.length) {
          setMensagens((atual) => mergeMessages(atual, novas));
          void marcarLidas(novas);
        }
      },
      lastSeenAt: mensagens[mensagens.length - 1]?.created_at ?? null,
    });
    return () => { void sub.unsubscribe(); };
    // Reassinar a cada mensagem derrubaria o canal o tempo todo; o
    // `lastSeenAt` é lido na montagem e o handler mantém o marcador interno.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comm, conversa.conversation_id, conversa.patient_id, marcarLidas]);

  async function enviar(corpo: string) {
    const limpo = corpo.trim();
    if (!limpo) return;
    setTexto('');
    await outbox.enqueue({
      clientId: newClientId(),
      conversationId: conversa.conversation_id,
      patientId: null,
      body: limpo,
      kind: 'text',
      urgency: 'normal',
    });
    requestAnimationFrame(() => lista.current?.scrollToEnd({ animated: true }));
  }

  const pendentes = saida.filter((i) => i.state !== 'sent');

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <View style={s.cabecalho}>
        <Pressable onPress={onVoltar} style={s.voltar} accessibilityRole="button">
          <Text style={s.voltarTexto}>‹ Voltar</Text>
        </Pressable>
        <View style={s.cabecalhoMeio}>
          <Text style={s.nome}>{conversa.patient_name}</Text>
          <Text style={s.status}>
            {conexao === 'connected'
              ? (conversa.patient_status === 'online' ? 'Online' : 'Offline')
              : 'Reconectando…'}
          </Text>
        </View>
      </View>

      {conexao !== 'connected' && (
        <View style={s.faixaConexao}>
          <Text style={s.faixaTexto}>
            Sem conexão em tempo real. Mensagens novas podem demorar a aparecer.
          </Text>
        </View>
      )}

      {carregando ? (
        <View style={s.centro}>
          <ActivityIndicator size="large" color={cores.primaria} />
        </View>
      ) : (
        <FlatList
          ref={lista}
          data={mensagens}
          keyExtractor={(m) => m.id}
          contentContainerStyle={s.lista}
          onContentSizeChange={() => lista.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => <Balao m={item} />}
          ListFooterComponent={
            pendentes.length ? (
              <View>
                {pendentes.map((p) => (
                  <BalaoPendente key={p.clientId} item={p} onRetentar={() => void outbox.retry(p.clientId)} />
                ))}
              </View>
            ) : null
          }
        />
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.rapidas}
        contentContainerStyle={s.rapidasConteudo}
      >
        {CAREGIVER_QUICK_REPLIES.map((r) => (
          <Pressable
            key={r.id}
            style={s.chip}
            onPress={() => void enviar(r.text)}
            accessibilityRole="button"
          >
            <Text style={s.chipTexto}>{r.text}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={s.barra}>
        <TextInput
          style={s.campo}
          value={texto}
          onChangeText={setTexto}
          placeholder="Escreva uma mensagem"
          placeholderTextColor={cores.textoFraco}
          multiline
          maxLength={2000}
          accessibilityLabel="Mensagem"
        />
        <Pressable
          style={[s.enviar, !texto.trim() && s.enviarInativo]}
          onPress={() => void enviar(texto)}
          disabled={!texto.trim()}
          accessibilityRole="button"
          accessibilityLabel="Enviar"
        >
          <Text style={s.enviarTexto}>›</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
};

const Balao: React.FC<{ m: Message }> = ({ m }) => {
  const meu = m.sender_kind === 'caregiver';
  const urgente = m.urgency === 'urgente' || m.urgency === 'emergencia';

  return (
    <View style={[s.balaoLinha, meu ? s.direita : s.esquerda]}>
      <View
        style={[
          s.balao,
          meu ? s.balaoMeu : s.balaoDele,
          urgente && !meu && s.balaoUrgente,
        ]}
      >
        {urgente && !meu && (
          <Text style={s.urgenteTag}>
            {m.urgency === 'emergencia' ? '🚨 EMERGÊNCIA' : '⚠ URGENTE'}
          </Text>
        )}
        <Text style={[s.balaoTexto, meu && s.balaoTextoMeu]}>{m.body}</Text>
        <Text style={[s.balaoHora, meu && s.balaoHoraMeu]}>
          {horaCurta(m.created_at)}
        </Text>
      </View>
    </View>
  );
};

/**
 * Mensagem ainda não confirmada pelo servidor.
 *
 * Cinza, itálico e com o estado escrito por extenso. Nunca um "✓".
 */
const BalaoPendente: React.FC<{ item: OutboxItem; onRetentar: () => void }> = ({
  item, onRetentar,
}) => (
  <View style={[s.balaoLinha, s.direita]}>
    <View style={[s.balao, s.balaoPendente]}>
      <Text style={s.balaoTextoPendente}>{item.body}</Text>
      {item.state === 'failed' ? (
        <Pressable onPress={onRetentar} accessibilityRole="button">
          <Text style={s.falhou}>Não enviada — toque para tentar de novo</Text>
        </Pressable>
      ) : (
        <Text style={s.enviando}>enviando…</Text>
      )}
    </View>
  </View>
);

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cabecalho: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: espaco.sm, paddingVertical: espaco.sm,
    backgroundColor: cores.cartao, borderBottomWidth: 1, borderBottomColor: cores.borda,
  },
  voltar: { minHeight: ALVO_MIN, minWidth: ALVO_MIN, justifyContent: 'center' },
  voltarTexto: { color: cores.primaria, fontSize: 17, fontWeight: '600' },
  cabecalhoMeio: { flex: 1, marginLeft: espaco.xs },
  nome: { fontSize: 18, fontWeight: '700', color: cores.texto },
  status: { fontSize: 12, color: cores.textoFraco },

  faixaConexao: { backgroundColor: '#FFFBEB', padding: espaco.sm },
  faixaTexto: { fontSize: 13, color: '#92400E', textAlign: 'center' },

  lista: { padding: espaco.md, paddingBottom: espaco.lg },
  balaoLinha: { flexDirection: 'row', marginBottom: espaco.sm },
  esquerda: { justifyContent: 'flex-start' },
  direita: { justifyContent: 'flex-end' },
  balao: { maxWidth: '82%', borderRadius: raio.lg, padding: espaco.md },
  balaoDele: {
    backgroundColor: cores.cartao, borderWidth: 1, borderColor: cores.borda,
    borderBottomLeftRadius: raio.sm,
  },
  balaoMeu: { backgroundColor: cores.primaria, borderBottomRightRadius: raio.sm },
  balaoUrgente: { borderColor: cores.urgente, borderWidth: 2, backgroundColor: '#FFFBEB' },
  balaoPendente: {
    backgroundColor: '#E2E8F0', borderBottomRightRadius: raio.sm,
  },
  urgenteTag: {
    fontSize: 11, fontWeight: '800', color: cores.urgente,
    marginBottom: espaco.xs, letterSpacing: 0.5,
  },
  balaoTexto: { fontSize: 16, color: cores.texto, lineHeight: 22 },
  balaoTextoMeu: { color: '#fff' },
  balaoTextoPendente: { fontSize: 16, color: cores.textoFraco, lineHeight: 22 },
  balaoHora: { fontSize: 11, color: cores.textoFraco, marginTop: espaco.xs, alignSelf: 'flex-end' },
  balaoHoraMeu: { color: '#C7D9F5' },
  enviando: { fontSize: 12, color: cores.textoFraco, fontStyle: 'italic', marginTop: espaco.xs },
  falhou: { fontSize: 12, color: cores.erro, fontWeight: '700', marginTop: espaco.xs },

  rapidas: { maxHeight: 56, backgroundColor: cores.fundo },
  rapidasConteudo: { paddingHorizontal: espaco.md, paddingBottom: espaco.sm, gap: espaco.sm },
  chip: {
    backgroundColor: cores.primariaFraca, borderRadius: raio.pill,
    paddingHorizontal: espaco.md, minHeight: 40, justifyContent: 'center',
    borderWidth: 1, borderColor: '#CBDDF5',
  },
  chipTexto: { color: cores.primaria, fontWeight: '600', fontSize: 14 },

  barra: {
    flexDirection: 'row', alignItems: 'flex-end', gap: espaco.sm,
    padding: espaco.sm, backgroundColor: cores.cartao,
    borderTopWidth: 1, borderTopColor: cores.borda,
  },
  campo: {
    flex: 1, minHeight: ALVO_MIN, maxHeight: 120, borderWidth: 1,
    borderColor: cores.borda, borderRadius: raio.lg,
    paddingHorizontal: espaco.md, paddingTop: 12, paddingBottom: 12,
    fontSize: 16, color: cores.texto, backgroundColor: cores.fundo,
  },
  enviar: {
    width: ALVO_MIN, height: ALVO_MIN, borderRadius: ALVO_MIN / 2,
    backgroundColor: cores.primaria, alignItems: 'center', justifyContent: 'center',
  },
  enviarInativo: { opacity: 0.35 },
  enviarTexto: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: -4 },
});
