import React, { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { entrar, recuperarAcesso } from '../hooks/useSession';
import { ALVO_MIN, cores, espaco, raio } from '../lib/theme';
import { configurado } from '../lib/supabase';

/**
 * Entrada do cuidador.
 *
 * Mesma conta do site da IrisFlow — não há cadastro aqui, de propósito: o
 * §7 manda reutilizar a autenticação existente, e um segundo cadastro
 * criaria duas identidades para a mesma pessoa, com o vínculo do paciente
 * pendurado na errada.
 */
export const LoginScreen: React.FC = () => {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const podeEnviar = email.trim().length > 3 && senha.length >= 6 && !ocupado;

  async function submeter() {
    if (!podeEnviar) return;
    setOcupado(true);
    setErro(null);
    setAviso(null);
    const e = await entrar(email, senha);
    setErro(e);
    setOcupado(false);
  }

  async function recuperar() {
    if (email.trim().length < 4) {
      setErro('Digite seu e-mail para receber o link de recuperação.');
      return;
    }
    setOcupado(true);
    setErro(null);
    const e = await recuperarAcesso(email);
    setOcupado(false);
    // Resposta idêntica exista ou não a conta: dizer "e-mail não encontrado"
    // transformaria esta tela num verificador de cadastros.
    if (e) setErro(e);
    else setAviso('Se houver uma conta com esse e-mail, o link foi enviado.');
  }

  if (!configurado) {
    return (
      <View style={[s.tela, s.centro]}>
        <Text style={s.titulo}>Configuração ausente</Text>
        <Text style={s.aviso}>
          Defina EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY e
          reinicie o app. Sem isso não há como buscar mensagens nem receber
          alertas — e preferimos dizer isso a abrir uma tela que não funciona.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Text style={s.marca}>IrisFlow</Text>
        <Text style={s.subtitulo}>Aplicativo do cuidador</Text>

        <Text style={s.rotulo}>E-mail</Text>
        <TextInput
          style={s.campo}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          placeholder="voce@exemplo.com"
          placeholderTextColor={cores.textoFraco}
          editable={!ocupado}
          accessibilityLabel="E-mail"
        />

        <Text style={s.rotulo}>Senha</Text>
        <TextInput
          style={s.campo}
          value={senha}
          onChangeText={setSenha}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          placeholder="••••••••"
          placeholderTextColor={cores.textoFraco}
          editable={!ocupado}
          onSubmitEditing={submeter}
          returnKeyType="go"
          accessibilityLabel="Senha"
        />

        {erro && (
          <Text style={s.erro} accessibilityLiveRegion="polite">{erro}</Text>
        )}
        {aviso && (
          <Text style={s.ok} accessibilityLiveRegion="polite">{aviso}</Text>
        )}

        <Pressable
          style={[s.botao, !podeEnviar && s.botaoInativo]}
          onPress={submeter}
          disabled={!podeEnviar}
          accessibilityRole="button"
          accessibilityLabel="Entrar"
        >
          {ocupado
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.botaoTexto}>Entrar</Text>}
        </Pressable>

        <Pressable
          style={s.link}
          onPress={recuperar}
          disabled={ocupado}
          accessibilityRole="button"
        >
          <Text style={s.linkTexto}>Esqueci minha senha</Text>
        </Pressable>

        <Text style={s.nota}>
          Use a mesma conta do site da IrisFlow.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  centro: { justifyContent: 'center', alignItems: 'center', padding: espaco.lg },
  conteudo: { padding: espaco.lg, paddingTop: espaco.xl * 2 },
  marca: { fontSize: 34, fontWeight: '800', color: cores.primaria, textAlign: 'center' },
  subtitulo: {
    fontSize: 16, color: cores.textoFraco, textAlign: 'center',
    marginTop: espaco.xs, marginBottom: espaco.xl,
  },
  titulo: { fontSize: 22, fontWeight: '700', color: cores.texto, marginBottom: espaco.md },
  rotulo: {
    fontSize: 14, fontWeight: '600', color: cores.texto,
    marginBottom: espaco.xs, marginTop: espaco.md,
  },
  campo: {
    minHeight: ALVO_MIN, borderWidth: 1, borderColor: cores.borda,
    borderRadius: raio.md, paddingHorizontal: espaco.md,
    fontSize: 17, color: cores.texto, backgroundColor: cores.cartao,
  },
  botao: {
    minHeight: ALVO_MIN + 8, backgroundColor: cores.primaria, borderRadius: raio.md,
    alignItems: 'center', justifyContent: 'center', marginTop: espaco.lg,
  },
  botaoInativo: { opacity: 0.4 },
  botaoTexto: { color: '#fff', fontSize: 18, fontWeight: '700' },
  link: { minHeight: ALVO_MIN, alignItems: 'center', justifyContent: 'center', marginTop: espaco.sm },
  linkTexto: { color: cores.primaria, fontSize: 15, fontWeight: '600' },
  erro: { color: cores.erro, fontSize: 15, marginTop: espaco.md, fontWeight: '600' },
  ok: { color: cores.sucesso, fontSize: 15, marginTop: espaco.md, fontWeight: '600' },
  aviso: { color: cores.textoFraco, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  nota: {
    color: cores.textoFraco, fontSize: 13, textAlign: 'center', marginTop: espaco.xl,
  },
});
