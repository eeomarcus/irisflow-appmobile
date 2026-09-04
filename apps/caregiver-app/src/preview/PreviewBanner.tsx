/**
 * FERRAMENTA DE DESENVOLVIMENTO — só renderiza com `EXPO_PUBLIC_PREVIEW=1`.
 *
 * Tarja permanente. Não é dispensável, não some com o scroll e não fica
 * discreta: enquanto os dados forem falsos, isso precisa estar dito na tela.
 * Uma demonstração convincente que ninguém identifica como demonstração é o
 * jeito mais fácil de alguém concluir que os alertas já funcionam.
 *
 * Traz também o botão que dispara a emergência de exemplo, porque é a tela
 * que mais interessa ver e a única que não dá para alcançar navegando.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { limparEmergencias, simularEmergencia } from './fakeSupabase';

interface Props {
  onEmergencia: (alertId: string, patientId: string, nome: string) => void;
}

export const PreviewBanner: React.FC<Props> = ({ onEmergencia }) => (
  <View style={s.barra}>
    <Text style={s.texto} numberOfLines={1}>
      PRÉ-VISUALIZAÇÃO · dados fictícios · push desativado
    </Text>

    <Pressable
      style={s.botao}
      onPress={() => {
        limparEmergencias();
        const id = simularEmergencia();
        onEmergencia(id, 'p-marta-0000-0000-000000000001', 'Marta (exemplo)');
      }}
      accessibilityRole="button"
    >
      <Text style={s.botaoTexto}>Ver emergência</Text>
    </Pressable>
  </View>
);

const s = StyleSheet.create({
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    backgroundColor: '#0F172A',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  texto: { color: '#FDE047', fontSize: 11, fontWeight: '800', letterSpacing: 0.5, flex: 1 },
  botao: {
    backgroundColor: '#DC2626',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  botaoTexto: { color: '#fff', fontSize: 11, fontWeight: '800' },
});
