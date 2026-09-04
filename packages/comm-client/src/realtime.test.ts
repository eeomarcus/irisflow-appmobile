import { describe, expect, it, vi } from 'vitest';
import { subscribeToConversation, startPresenceHeartbeat } from './realtime';
import { mergeMessages } from './messages';
import type { Message } from './types';

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversation_id: 'conv-1',
    client_message_id: 'cli-1',
    sender_kind: 'patient',
    sender_user_id: null,
    kind: 'quick_phrase',
    urgency: 'normal',
    body: 'oi',
    created_at: '2026-09-03T10:00:00.000Z',
    server_received_at: '2026-09-03T10:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

/**
 * Canal falso que captura os handlers e permite ao teste disparar eventos e
 * mudanças de status na mão.
 */
function supabaseFake() {
  const handlers: Array<{
    cfg: { table: string; event: string; filter?: string };
    fn: (p: { new?: unknown; old?: unknown }) => void;
  }> = [];
  let statusCb: ((s: string) => void) | null = null;

  const channel = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(_tipo: string, cfg: any, fn: any) {
      handlers.push({ cfg, fn });
      return channel;
    },
    subscribe(cb: (s: string) => void) {
      statusCb = cb;
      return channel;
    },
  };

  const supabase = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => 'ok'),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };

  return {
    supabase,
    handlers,
    emitir(table: string, novo: unknown) {
      for (const h of handlers) if (h.cfg.table === table) h.fn({ new: novo });
    },
    status(s: string) {
      statusCb?.(s);
    },
  };
}

describe('subscribeToConversation', () => {
  it('assina messages, message_receipts e emergency_alerts', () => {
    const f = supabaseFake();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1',
      patientId: 'pac-1',
      onMessage: () => {},
    });

    const tabelas = f.handlers.map((h) => h.cfg.table);
    expect(tabelas).toContain('messages');
    expect(tabelas).toContain('message_receipts');
    expect(tabelas).toContain('emergency_alerts');
  });

  it('filtra por conversa e por paciente', () => {
    const f = supabaseFake();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1',
      patientId: 'pac-1',
      onMessage: () => {},
    });

    const m = f.handlers.find((h) => h.cfg.table === 'messages');
    const a = f.handlers.find((h) => h.cfg.table === 'emergency_alerts');
    expect(m?.cfg.filter).toBe('conversation_id=eq.conv-1');
    expect(a?.cfg.filter).toBe('patient_id=eq.pac-1');
  });

  it('entrega a mensagem recebida', () => {
    const f = supabaseFake();
    const onMessage = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1', patientId: 'pac-1', onMessage,
    });

    f.emitir('messages', msg({ id: 'novo' }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'novo' }));
  });

  it('dispara catch-up a cada SUBSCRIBED — conectado não é o mesmo que em dia', () => {
    const f = supabaseFake();
    const onCatchUp = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1',
      patientId: 'pac-1',
      onMessage: () => {},
      onCatchUp,
      lastSeenAt: '2026-09-03T09:00:00.000Z',
    });

    f.status('SUBSCRIBED');
    expect(onCatchUp).toHaveBeenCalledWith('2026-09-03T09:00:00.000Z');

    // Reconexão: sem um segundo catch-up, o intervalo em que o cliente esteve
    // fora viraria um buraco silencioso no histórico.
    f.status('CLOSED');
    f.status('SUBSCRIBED');
    expect(onCatchUp).toHaveBeenCalledTimes(2);
  });

  it('avança o marcador de catch-up conforme as mensagens chegam', () => {
    const f = supabaseFake();
    const onCatchUp = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1',
      patientId: 'pac-1',
      onMessage: () => {},
      onCatchUp,
      lastSeenAt: '2026-09-03T09:00:00.000Z',
    });

    f.status('SUBSCRIBED');
    f.emitir('messages', msg({ created_at: '2026-09-03T11:00:00.000Z' }));
    f.status('CLOSED');
    f.status('SUBSCRIBED');

    // O segundo catch-up parte de onde parou, não do início.
    expect(onCatchUp).toHaveBeenLastCalledWith('2026-09-03T11:00:00.000Z');
  });

  it('reporta os estados de conexão para a interface', () => {
    const f = supabaseFake();
    const onStatus = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1', patientId: 'pac-1', onMessage: () => {}, onStatus,
    });

    f.status('SUBSCRIBED');
    expect(onStatus).toHaveBeenCalledWith('connected');
    f.status('CHANNEL_ERROR');
    expect(onStatus).toHaveBeenCalledWith('error');
    f.status('CLOSED');
    expect(onStatus).toHaveBeenCalledWith('reconnecting');
  });

  it('mensagem vinda pelo realtime e pelo catch-up aparece uma vez só', () => {
    const recebidas: Message[] = [];
    const f = supabaseFake();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1',
      patientId: 'pac-1',
      onMessage: (m) => recebidas.push(m),
    });

    const m = msg({ id: 'm-dupla', client_message_id: 'cli-dupla' });
    f.emitir('messages', m);
    const doCatchUp = [m];

    // É esta combinação que o app usa: realtime + catch-up, conciliados.
    expect(mergeMessages(recebidas, doCatchUp)).toHaveLength(1);
  });

  it('unsubscribe remove o canal', async () => {
    const f = supabaseFake();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = subscribeToConversation(f.supabase as any, {
      conversationId: 'conv-1', patientId: 'pac-1', onMessage: () => {},
    });

    await sub.unsubscribe();
    expect(f.supabase.removeChannel).toHaveBeenCalled();
  });
});

describe('startPresenceHeartbeat', () => {
  it('bate imediatamente, sem esperar o primeiro intervalo', async () => {
    vi.useFakeTimers();
    const f = supabaseFake();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parar = startPresenceHeartbeat(f.supabase as any, 'pac-1');
    await vi.advanceTimersByTimeAsync(0);

    // Abrir o IrisFlow e o cuidador continuar vendo "offline" por um minuto
    // seria informação errada na hora em que ela mais importa.
    expect(f.supabase.rpc).toHaveBeenCalledWith('touch_presence', {
      p_patient_id: 'pac-1', p_irisflow_running: true,
    });

    parar();
    vi.useRealTimers();
  });

  it('repete no intervalo e para quando cancelado', async () => {
    vi.useFakeTimers();
    const f = supabaseFake();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parar = startPresenceHeartbeat(f.supabase as any, 'pac-1', { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    const antes = f.supabase.rpc.mock.calls.length;
    expect(antes).toBeGreaterThanOrEqual(4);

    parar();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.supabase.rpc.mock.calls.length).toBe(antes);

    vi.useRealTimers();
  });

  it('falha de heartbeat não derruba nada — é reportada e segue', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const supabase = {
      rpc: vi.fn(async () => {
        throw new Error('sem rede');
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parar = startPresenceHeartbeat(supabase as any, 'pac-1', { onError });
    await vi.advanceTimersByTimeAsync(0);

    // O paciente segue usando o IrisFlow normalmente; o servidor marca
    // offline sozinho depois de 3 minutos sem sinal.
    expect(onError).toHaveBeenCalled();

    parar();
    vi.useRealTimers();
  });
});
