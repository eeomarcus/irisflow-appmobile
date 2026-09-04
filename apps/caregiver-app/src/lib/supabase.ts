/**
 * Cliente Supabase do app do cuidador.
 *
 * A decisão que importa aqui é onde a sessão fica guardada.
 *
 * O padrão da maioria dos tutoriais é `AsyncStorage`. Ele grava em texto
 * puro dentro do sandbox do app — o que basta contra outro aplicativo, e não
 * basta contra um aparelho com root, um backup não criptografado ou uma
 * extração forense. O que está guardado ali é o refresh token que dá acesso
 * a conversas de saúde de uma pessoa vulnerável, então vai para o
 * `expo-secure-store`: Keychain no iOS, Keystore no Android.
 *
 * O custo é o limite de 2 KB por entrada do SecureStore, que uma sessão do
 * Supabase pode ultrapassar. Por isso o adaptador fatia o valor em pedaços.
 */

import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import {
  createCommClient,
  isCommConfigured,
  type CommClient,
  type StorageAdapter,
} from '@irisflow/comm-client';

const LIMITE_SECURE_STORE = 1800;   // margem sob os 2048 bytes

/**
 * Adaptador com fatiamento.
 *
 * `chave` guarda o número de pedaços; `chave.0`, `chave.1` … guardam o
 * conteúdo. Um valor curto continua cabendo em uma entrada só.
 */
function secureStorage(): StorageAdapter {
  return {
    async getItem(key) {
      try {
        const cabecalho = await SecureStore.getItemAsync(key);
        if (cabecalho === null) return null;

        const partes = Number(cabecalho);
        if (!Number.isInteger(partes) || partes <= 0) return cabecalho;

        const pedacos: string[] = [];
        for (let i = 0; i < partes; i += 1) {
          const p = await SecureStore.getItemAsync(`${key}.${i}`);
          // Um pedaço faltando torna o conjunto inútil: melhor tratar como
          // sessão ausente (o usuário faz login de novo) do que devolver
          // JSON truncado, que quebraria em algum ponto imprevisível.
          if (p === null) return null;
          pedacos.push(p);
        }
        return pedacos.join('');
      } catch {
        return null;
      }
    },

    async setItem(key, value) {
      try {
        await limpar(key);
        if (value.length <= LIMITE_SECURE_STORE) {
          await SecureStore.setItemAsync(key, value);
          return;
        }
        const partes = Math.ceil(value.length / LIMITE_SECURE_STORE);
        for (let i = 0; i < partes; i += 1) {
          await SecureStore.setItemAsync(
            `${key}.${i}`,
            value.slice(i * LIMITE_SECURE_STORE, (i + 1) * LIMITE_SECURE_STORE),
          );
        }
        await SecureStore.setItemAsync(key, String(partes));
      } catch {
        // Falhar aqui significa não persistir a sessão: o cuidador vai ter
        // que entrar de novo no próximo boot. Ruim, e ainda assim melhor do
        // que derrubar o app na tela de login.
      }
    },

    async removeItem(key) {
      await limpar(key);
    },
  };
}

async function limpar(key: string): Promise<void> {
  try {
    const cabecalho = await SecureStore.getItemAsync(key);
    const partes = Number(cabecalho);
    if (Number.isInteger(partes) && partes > 0) {
      for (let i = 0; i < partes; i += 1) {
        await SecureStore.deleteItemAsync(`${key}.${i}`);
      }
    }
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* nada a limpar */
  }
}

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | null>;

export const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? extra.supabaseUrl ?? '';
export const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? extra.supabaseAnonKey ?? '';

/**
 * Modo de pré-visualização — ferramenta de desenvolvimento.
 *
 * Ligado por `EXPO_PUBLIC_PREVIEW=1`, troca o cliente Supabase por uma
 * implementação em memória (`src/preview/`). Serve para ver e navegar as
 * telas sem provisionar banco, criar conta e parear paciente.
 *
 * A troca é aqui, na camada de dados, e não nas telas: `PatientsScreen`,
 * `ConversationScreen` e `EmergencyScreen` rodam sem uma linha alterada. O
 * que aparece na tela é o componente real — se fossem telas de demonstração
 * separadas, a demonstração poderia estar certa e o produto errado.
 *
 * `assertPreviewSafe()` lança em build de produção, e o app exibe uma tarja
 * permanente enquanto o modo estiver ativo (§25.8: mock não é solução final).
 */
export const PREVIEW = process.env.EXPO_PUBLIC_PREVIEW === '1';

export const configurado =
  PREVIEW ||
  isCommConfigured({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    storage: secureStorage(),
  });

/**
 * Instância única.
 *
 * Duas instâncias abririam duas conexões de Realtime e dois relógios de
 * refresh sobre a mesma sessão, que é a receita conhecida para tokens
 * invalidando um ao outro.
 */
export const comm: CommClient | null = PREVIEW
  ? criarClientePreview()
  : createCommClient({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      storage: secureStorage(),
    });

function criarClientePreview(): CommClient {
  // `require` e não `import`: assim o módulo de pré-visualização e seus dados
  // de exemplo ficam fora do bundle quando a variável não está ligada.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const preview = require('../preview/fakeSupabase') as typeof import('../preview/fakeSupabase');
  preview.assertPreviewSafe();
  return {
    supabase: preview.criarSupabaseFalso(),
    storage: secureStorage(),
    now: () => Date.now(),
  };
}

export function requireComm(): CommClient {
  if (!comm) {
    throw new Error(
      'Supabase não configurado. Defina EXPO_PUBLIC_SUPABASE_URL e ' +
        'EXPO_PUBLIC_SUPABASE_ANON_KEY antes de iniciar o app.',
    );
  }
  return comm;
}
