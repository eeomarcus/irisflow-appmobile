/**
 * Fábrica do cliente Supabase e utilidades transversais.
 *
 * A escolha estrutural aqui: `isCommConfigured()`. Sem URL e chave, este
 * módulo devolve `null` em vez de criar um cliente inválido. É o mesmo
 * padrão que `irisflow-site/src/lib/supabase.ts` já usa, e existe pela razão
 * que o Blinkv1 torna urgente — o desktop precisa continuar funcionando
 * exatamente como hoje quando ninguém configurou nada. Um cliente meio
 * inicializado produziria erro de rede solto no console de uma pessoa que
 * está tentando pedir ajuda.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CommConfig, StorageAdapter } from './types';

/** Adaptador em memória. Usado nos testes e como fallback seguro. */
export function memoryStorage(): StorageAdapter {
  const mapa = new Map<string, string>();
  return {
    getItem: async (k) => mapa.get(k) ?? null,
    setItem: async (k, v) => void mapa.set(k, v),
    removeItem: async (k) => void mapa.delete(k),
  };
}

/**
 * Adaptador sobre `localStorage` (Electron / navegador).
 *
 * O try/catch não é zelo excessivo: em modo privado o Safari lança em
 * `setItem` quando a cota estoura, e num app cujo outbox guarda o pedido de
 * ajuda, uma exceção não tratada aqui derrubaria o envio.
 */
export function webStorage(): StorageAdapter {
  return {
    getItem: async (k) => {
      try {
        return globalThis.localStorage?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    setItem: async (k, v) => {
      try {
        globalThis.localStorage?.setItem(k, v);
      } catch {
        /* cota cheia ou storage bloqueado: o item vive só na memória do outbox */
      }
    },
    removeItem: async (k) => {
      try {
        globalThis.localStorage?.removeItem(k);
      } catch {
        /* idem */
      }
    },
  };
}

export interface CommClient {
  supabase: SupabaseClient;
  storage: StorageAdapter;
  now: () => number;
}

export function isCommConfigured(
  cfg: Partial<CommConfig> | null | undefined,
): cfg is CommConfig {
  return Boolean(cfg?.supabaseUrl?.trim() && cfg?.supabaseAnonKey?.trim() && cfg?.storage);
}

export const AVISO_SEM_CONFIG =
  'Comunicação com o cuidador não configurada. Defina a URL e a chave anônima ' +
  'do Supabase para habilitar mensagens e alertas remotos.';

/**
 * Cria o cliente, ou `null` quando não há configuração.
 *
 * `null` e não exceção: quem chama precisa poder desabilitar a
 * funcionalidade na interface, e um throw obrigaria todo ponto de uso a
 * embrulhar em try/catch.
 */
export function createCommClient(cfg: Partial<CommConfig>): CommClient | null {
  if (!isCommConfigured(cfg)) return null;

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: {
        getItem: (k) => cfg.storage.getItem(k) as unknown as string | null,
        setItem: (k, v) => void cfg.storage.setItem(k, v),
        removeItem: (k) => void cfg.storage.removeItem(k),
      },
    },
    realtime: {
      // ~10 eventos/s por cliente. O padrão do SDK (10/s também) é adequado;
      // deixamos explícito para que uma mudança futura no SDK não altere em
      // silêncio o comportamento do canal de emergência.
      params: { eventsPerSecond: 10 },
    },
  });

  return { supabase, storage: cfg.storage, now: cfg.now ?? (() => Date.now()) };
}

/**
 * UUID v4.
 *
 * `crypto.randomUUID` existe no Electron e no Hermes recente, mas não em
 * todo runtime React Native — e este id é a chave de idempotência de uma
 * mensagem de emergência. O fallback usa `getRandomValues`, que é
 * criptograficamente seguro; só cai em `Math.random` se nem isso existir,
 * caso em que a colisão continua improvável e a alternativa seria não
 * enviar nada.
 */
export function newClientId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // versão 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variante RFC 4122

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Erro do canal, com a distinção que mais importa para o outbox:
 * `retryable`.
 *
 * Um 403 não melhora com retentativa — retentar é gastar bateria e adiar o
 * momento em que o usuário descobre que não tem permissão. Um erro de rede,
 * ao contrário, quase sempre melhora.
 */
export class CommError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'CommError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Códigos do Postgres/PostgREST que não adianta retentar. */
const NAO_RETENTAVEIS = new Set([
  '42501', // permissão negada — vínculo inexistente ou revogado
  '28000', // não autenticado
  '22023', // transição de estado inválida
  '23514', // violação de CHECK — corpo vazio ou longo demais
  '23503', // FK inexistente — conversa apagada
  'PGRST301', // JWT expirado (o SDK renova; retentar aqui atropelaria)
]);

export function toCommError(err: unknown): CommError {
  if (err instanceof CommError) return err;

  const e = err as { code?: string; message?: string; status?: number } | null;
  const code = e?.code ?? (e?.status ? `HTTP_${e.status}` : 'DESCONHECIDO');
  const msg = e?.message ?? 'Falha na comunicação';

  // 54000 é o rate limit de mensagens: vale retentar, mas depois. O backoff
  // do outbox cuida do "depois".
  if (code === '54000') return new CommError(msg, code, true);

  // 4xx é erro do pedido; 5xx e falha de rede são do outro lado.
  const status = e?.status ?? 0;
  const retryable =
    !NAO_RETENTAVEIS.has(code) && (status === 0 || status === 429 || status >= 500);

  return new CommError(msg, code, retryable);
}
