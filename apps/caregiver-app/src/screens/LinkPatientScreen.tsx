import React, { useState } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { requireComm, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase';
import { ALVO_MIN, cores, espaco, raio } from '../lib/theme';

interface Props {
  onVinculado: () => void;
  onCancelar: () => void;
}

/**
 * Vínculo por código de 8 caracteres (§6).
 *
 * O código é gerado no IrisFlow do paciente e dito por telefone ou anotado
 * num papel. Não há convite por e-mail de propósito: um endpoint que aceita
 * e-mail e responde "enviado" ou "não existe" é um oráculo de enumeração de
 * usuários (§23), e aqui a base é de pessoas com deficiência — uma lista que
 * não deve poder ser confirmada por ninguém de fora.
 */
export const LinkPatientScreen: React.FC<Props> = ({ onVinculado, onCancelar }) => {
  const comm = requireComm();
  const [codigo, setCodigo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // O alfabeto do servidor exclui 0/O e 1/I/L: ditar "zero ou ó" por telefone
  // é falha de usabilidade que vira falha de suporte.
  const limpo = codigo.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
  const completo = limpo.length === 8;

  async function vincular() {
    if (!completo || ocupado) return;
    setOcupado(true);
    setErro(null);

    try {
      const { data: sessao } = await comm.supabase.auth.getSession();
      const token = sessao.session?.access_token;
      if (!token) {
        setErro('Sessão expirada. Entre novamente.');
        return;
      }

      // Edge Function, não RPC: validar o código exige ler care_link_invites,
      // e a RLS dessa tabela — corretamente — não libera para quem ainda não
      // tem vínculo. O service role fica isolado numa função só.
      const res = await fetch(`${SUPABASE_URL}/functions/v1/link-accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ code: limpo }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok || !body?.ok) {
        // Mensagem única para inválido, expirado e já usado — a mesma
        // indistinção que o servidor mantém.
        setErro(body?.message ?? 'Código inválido, expirado ou já utilizado.');
        return;
      }

      setOk(`Vinculado a ${body.patient_name ?? 'paciente'}.`);
      setTimeout(onVinculado, 900);
    } catch {
      setErro('Sem conexão. Verifique sua internet e tente de novo.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <View style={s.tela}>
      <Pressable onPress={onCancelar} style={s.voltar} accessibilityRole="button">
        <Text style={s.voltarTexto}>‹ Voltar</Text>
      </Pressable>

      <Text style={s.titulo}>Vincular paciente</Text>
      <Text style={s.texto}>
        No IrisFlow do paciente, abra{' '}
        <Text style={s.negrito}>Cuidador › Vincular novo cuidador</Text> e
        digite aqui o código de 8 letras que aparecer.
      </Text>

      <TextInput
        style={s.campo}
        value={limpo}
        onChangeText={setCodigo}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={8}
        placeholder="ABCD2345"
        placeholderTextColor="#CBD5E1"
        editable={!ocupado && !ok}
        accessibilityLabel="Código de vínculo"
      />

      {erro && <Text style={s.erro} accessibilityLiveRegion="polite">{erro}</Text>}
      {ok && <Text style={s.ok} accessibilityLiveRegion="polite">{ok}</Text>}

      <Pressable
        style={[s.botao, (!completo || ocupado || !!ok) && s.botaoInativo]}
        onPress={() => void vincular()}
        disabled={!completo || ocupado || !!ok}
        accessibilityRole="button"
      >
        {ocupado
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.botaoTexto}>Vincular</Text>}
      </Pressable>

      <Text style={s.nota}>
        O código vale por 24 horas e só pode ser usado uma vez.
      </Text>
    </View>
  );
};

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo, padding: espaco.lg },
  voltar: { minHeight: ALVO_MIN, justifyContent: 'center' },
  voltarTexto: { color: cores.primaria, fontSize: 17, fontWeight: '600' },
  titulo: { fontSize: 26, fontWeight: '800', color: cores.texto, marginTop: espaco.md },
  texto: {
    fontSize: 16, color: cores.textoFraco, lineHeight: 24, marginTop: espaco.sm,
  },
  negrito: { fontWeight: '700', color: cores.texto },
  campo: {
    minHeight: 72, borderWidth: 2, borderColor: cores.borda, borderRadius: raio.md,
    marginTop: espaco.xl, fontSize: 34, fontWeight: '800', letterSpacing: 8,
    textAlign: 'center', color: cores.texto, backgroundColor: cores.cartao,
  },
  botao: {
    minHeight: ALVO_MIN + 8, backgroundColor: cores.primaria, borderRadius: raio.md,
    alignItems: 'center', justifyContent: 'center', marginTop: espaco.lg,
  },
  botaoInativo: { opacity: 0.4 },
  botaoTexto: { color: '#fff', fontSize: 18, fontWeight: '700' },
  erro: { color: cores.erro, fontSize: 15, fontWeight: '600', marginTop: espaco.md },
  ok: { color: cores.sucesso, fontSize: 15, fontWeight: '600', marginTop: espaco.md },
  nota: {
    fontSize: 13, color: cores.textoFraco, textAlign: 'center', marginTop: espaco.lg,
  },
});
