import { describe, expect, it, vi } from 'vitest';
import {
  CommError,
  createCommClient,
  isCommConfigured,
  memoryStorage,
  newClientId,
  toCommError,
  webStorage,
} from './client';

describe('configuração ausente', () => {
  it('não cria cliente sem URL ou chave', () => {
    const storage = memoryStorage();
    expect(createCommClient({ storage })).toBeNull();
    expect(createCommClient({ supabaseUrl: 'https://x.supabase.co', storage })).toBeNull();
    expect(createCommClient({ supabaseAnonKey: 'k', storage })).toBeNull();
  });

  it('trata string em branco como ausente', () => {
    // '   ' vindo de um .env mal preenchido criaria um cliente que só produz
    // erro de rede no console de quem está tentando pedir ajuda.
    expect(
      isCommConfigured({ supabaseUrl: '   ', supabaseAnonKey: 'k', storage: memoryStorage() }),
    ).toBe(false);
  });

  it('cria o cliente quando tudo está presente', () => {
    const c = createCommClient({
      supabaseUrl: 'https://exemplo.supabase.co',
      supabaseAnonKey: 'chave-anon',
      storage: memoryStorage(),
    });
    expect(c).not.toBeNull();
    expect(c!.supabase).toBeDefined();
  });

  it('lê a sessão do storage injetado, não de um padrão global', async () => {
    const storage = memoryStorage();
    const get = vi.spyOn(storage, 'getItem');

    const c = createCommClient({
      supabaseUrl: 'https://exemplo.supabase.co',
      supabaseAnonKey: 'chave-anon',
      storage,
    });

    // Sem esta injeção, o Expo cairia no AsyncStorage padrão (texto puro, no
    // sandbox do app) em vez do secure store, e o Electron gravaria a sessão
    // do paciente em localStorage.
    await c!.supabase.auth.getSession().catch(() => {});
    expect(get).toHaveBeenCalled();
  });

  it('aceita um relógio injetado', () => {
    const c = createCommClient({
      supabaseUrl: 'https://exemplo.supabase.co',
      supabaseAnonKey: 'k',
      storage: memoryStorage(),
      now: () => 12345,
    });
    expect(c!.now()).toBe(12345);
  });
});

describe('webStorage', () => {
  it('devolve null em vez de lançar quando o storage está bloqueado', async () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('acesso negado');
      },
    });

    const s = webStorage();
    // Uma exceção aqui derrubaria o outbox — e com ele o pedido de ajuda.
    await expect(s.getItem('x')).resolves.toBeNull();
    await expect(s.setItem('x', 'y')).resolves.toBeUndefined();
    await expect(s.removeItem('x')).resolves.toBeUndefined();

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, value: original,
    });
  });
});

describe('newClientId', () => {
  it('gera UUID v4 válido', () => {
    const id = newClientId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('não repete', () => {
    const ids = new Set(Array.from({ length: 2000 }, newClientId));
    expect(ids.size).toBe(2000);
  });

  it('funciona sem crypto.randomUUID (React Native antigo)', () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: original.getRandomValues.bind(original) },
    });

    const id = newClientId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true, value: original,
    });
  });
});

describe('toCommError', () => {
  it('não retenta permissão negada', () => {
    // Retentar um 403 é gastar bateria e adiar o momento em que o usuário
    // descobre que não tem acesso.
    expect(toCommError({ code: '42501', message: 'negado' }).retryable).toBe(false);
  });

  it('não retenta sessão ausente nem transição inválida', () => {
    expect(toCommError({ code: '28000', message: 'sem auth' }).retryable).toBe(false);
    expect(toCommError({ code: '22023', message: 'invalido' }).retryable).toBe(false);
  });

  it('não retenta JWT expirado — quem renova é o SDK', () => {
    expect(toCommError({ code: 'PGRST301', message: 'jwt expired' }).retryable).toBe(false);
  });

  it('retenta falha de rede, 5xx e 429', () => {
    expect(toCommError({ message: 'network' }).retryable).toBe(true);
    expect(toCommError({ status: 503, message: 'indisponivel' }).retryable).toBe(true);
    expect(toCommError({ status: 429, message: 'muitas' }).retryable).toBe(true);
  });

  it('não retenta 4xx genérico', () => {
    expect(toCommError({ status: 400, message: 'pedido ruim' }).retryable).toBe(false);
  });

  it('retenta o rate limit do send_message', () => {
    expect(toCommError({ code: '54000', message: 'limite' }).retryable).toBe(true);
  });

  it('preserva um CommError já construído', () => {
    const e = new CommError('x', 'CODE', false);
    expect(toCommError(e)).toBe(e);
  });
});
