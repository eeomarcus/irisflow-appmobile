import { describe, expect, it, vi } from 'vitest';
import {
  broadcastPatientMessage,
  fetchHistory,
  fetchSince,
  markDelivered,
  markRead,
  mergeMessages,
  sendMessage,
} from './messages';
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
    body: 'Estou com sede.',
    created_at: '2026-09-03T10:00:00.000Z',
    server_received_at: '2026-09-03T10:00:00.100Z',
    deleted_at: null,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function supabaseRpc(resposta: any): any {
  return { rpc: vi.fn(async () => resposta) };
}

/**
 * Stub encadeável do query builder. Registra as chamadas para o teste poder
 * afirmar QUAIS filtros foram aplicados — é assim que se verifica que uma
 * consulta não vaza mensagem apagada, por exemplo.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function supabaseFrom(linhas: any[], registro: string[] = []): any {
  const builder: Record<string, unknown> = {};
  const encadeia = (nome: string) => (...args: unknown[]) => {
    registro.push(`${nome}(${args.map((a) => JSON.stringify(a)).join(',')})`);
    return builder;
  };
  for (const m of ['select', 'eq', 'is', 'in', 'lt', 'gt', 'order', 'update']) {
    builder[m] = encadeia(m);
  }
  builder.limit = encadeia('limit');
  // O builder do supabase-js é "thenable": os filtros continuam encadeáveis
  // depois de `.limit()`, e a consulta só dispara quando aguardada. O stub
  // precisa imitar isso — devolver uma Promise em `.limit()` quebraria o
  // `.lt()` que a paginação aplica depois.
  builder.then = (res: (v: unknown) => unknown) =>
    res({ data: linhas, error: null });

  return { from: vi.fn(() => builder), __registro: registro };
}

describe('sendMessage', () => {
  it('passa o client_message_id — a chave que torna o reenvio idempotente', async () => {
    const supabase = supabaseRpc({ data: msg(), error: null });
    await sendMessage(supabase, {
      conversationId: 'conv-1',
      clientMessageId: 'cli-1',
      body: 'Estou com sede.',
      kind: 'quick_phrase',
      urgency: 'importante',
    });

    expect(supabase.rpc).toHaveBeenCalledWith('send_message', {
      p_conversation_id: 'conv-1',
      p_client_message_id: 'cli-1',
      p_body: 'Estou com sede.',
      p_kind: 'quick_phrase',
      p_urgency: 'importante',
    });
  });

  it('nunca envia sender_kind nem sender_user_id', async () => {
    const supabase = supabaseRpc({ data: msg(), error: null });
    await sendMessage(supabase, {
      conversationId: 'conv-1',
      clientMessageId: 'cli-1',
      body: 'oi',
    });

    // O remetente é derivado de auth.uid() no servidor. Se o cliente pudesse
    // declará-lo, seria o "alteração de caregiver_id" do §23.
    const args = supabase.rpc.mock.calls[0][1];
    expect(Object.keys(args)).not.toContain('p_sender_kind');
    expect(Object.keys(args)).not.toContain('p_sender_user_id');
  });

  it('reenvio devolve a mesma mensagem, e isso é sucesso', async () => {
    const original = msg({ id: 'm-original' });
    const supabase = supabaseRpc({ data: original, error: null });

    const a = await sendMessage(supabase, {
      conversationId: 'conv-1', clientMessageId: 'cli-1', body: 'oi',
    });
    const b = await sendMessage(supabase, {
      conversationId: 'conv-1', clientMessageId: 'cli-1', body: 'oi',
    });

    expect(a.id).toBe(b.id);
    expect(b.id).toBe('m-original');
  });

  it('marca 403 como não retentável e 503 como retentável', async () => {
    const negado = supabaseRpc({
      data: null, error: { code: '42501', message: 'conversa inacessivel' },
    });
    await expect(
      sendMessage(negado, { conversationId: 'de-outro', clientMessageId: 'c', body: 'x' }),
    ).rejects.toMatchObject({ code: '42501', retryable: false });

    const fora = supabaseRpc({
      data: null, error: { status: 503, message: 'indisponivel' },
    });
    await expect(
      sendMessage(fora, { conversationId: 'conv-1', clientMessageId: 'c', body: 'x' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('trata o rate limit como retentável — o backoff resolve', async () => {
    const supabase = supabaseRpc({
      data: null, error: { code: '54000', message: 'limite por minuto' },
    });
    await expect(
      sendMessage(supabase, { conversationId: 'conv-1', clientMessageId: 'c', body: 'x' }),
    ).rejects.toMatchObject({ code: '54000', retryable: true });
  });

  it('usa text/normal como padrão', async () => {
    const supabase = supabaseRpc({ data: msg(), error: null });
    await sendMessage(supabase, {
      conversationId: 'conv-1', clientMessageId: 'c', body: 'oi',
    });
    const args = supabase.rpc.mock.calls[0][1];
    expect(args.p_kind).toBe('text');
    expect(args.p_urgency).toBe('normal');
  });
});

describe('broadcastPatientMessage', () => {
  it('usa o mesmo client_message_id em todas as conversas', async () => {
    const supabase = supabaseRpc({
      data: [
        msg({ id: 'm1', conversation_id: 'conv-1', client_message_id: 'cli-x' }),
        msg({ id: 'm2', conversation_id: 'conv-2', client_message_id: 'cli-x' }),
      ],
      error: null,
    });

    const r = await broadcastPatientMessage(supabase, {
      patientId: 'pac-1', clientMessageId: 'cli-x', body: 'Preciso de ajuda.',
    });

    // A unique é por conversa: mesmo id em fios diferentes não colide, e cada
    // fio continua idempotente na retentativa.
    expect(r).toHaveLength(2);
    expect(new Set(r.map((m) => m.client_message_id)).size).toBe(1);
    expect(new Set(r.map((m) => m.conversation_id)).size).toBe(2);
  });

  it('devolve lista vazia quando não há cuidador vinculado', async () => {
    const supabase = supabaseRpc({ data: [], error: null });
    const r = await broadcastPatientMessage(supabase, {
      patientId: 'pac-1', clientMessageId: 'c', body: 'oi',
    });
    expect(r).toEqual([]);
  });
});

describe('histórico', () => {
  it('exclui mensagens apagadas e devolve em ordem cronológica', async () => {
    const registro: string[] = [];
    const supabase = supabaseFrom(
      [
        msg({ id: 'novo', created_at: '2026-09-03T12:00:00.000Z' }),
        msg({ id: 'velho', created_at: '2026-09-03T10:00:00.000Z' }),
      ],
      registro,
    );

    const r = await fetchHistory(supabase, 'conv-1');

    expect(registro.join(' ')).toContain('is("deleted_at",null)');
    // O banco devolve do mais novo para o mais velho; a tela quer o inverso.
    expect(r.map((m) => m.id)).toEqual(['velho', 'novo']);
  });

  it('pagina com "before"', async () => {
    const registro: string[] = [];
    const supabase = supabaseFrom([], registro);
    await fetchHistory(supabase, 'conv-1', { before: '2026-09-03T10:00:00.000Z', limit: 20 });

    expect(registro.join(' ')).toContain('lt("created_at","2026-09-03T10:00:00.000Z")');
    expect(registro.join(' ')).toContain('limit(20)');
  });

  it('fetchSince usa gt, não gte — senão repetiria a última mensagem sempre', async () => {
    const registro: string[] = [];
    const supabase = supabaseFrom([], registro);
    await fetchSince(supabase, 'conv-1', '2026-09-03T10:00:00.000Z');

    expect(registro.join(' ')).toContain('gt("created_at"');
  });
});

describe('recibos', () => {
  it('não chama o servidor com lista vazia', async () => {
    const supabase = supabaseRpc({ data: 0, error: null });
    expect(await markDelivered(supabase, [])).toBe(0);
    expect(await markRead(supabase, [])).toBe(0);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('envia só os ids — o destinatário é sempre auth.uid()', async () => {
    const supabase = supabaseRpc({ data: 2, error: null });
    await markRead(supabase, ['m1', 'm2']);

    // Deixar o cliente escolher o destinatário permitiria marcar como lida
    // uma mensagem que outra pessoa nunca viu.
    expect(supabase.rpc).toHaveBeenCalledWith('mark_messages_read', {
      p_message_ids: ['m1', 'm2'],
    });
  });
});

describe('mergeMessages', () => {
  it('deduplica o item que chega pelo realtime e pelo catch-up', () => {
    const m = msg({ id: 'm1', client_message_id: 'cli-1' });
    const r = mergeMessages([m], [m]);
    expect(r).toHaveLength(1);
  });

  it('deduplica o eco local: a própria mensagem voltando pelo realtime', () => {
    const otimista = msg({ id: 'm1', client_message_id: 'cli-1' });
    const doServidor = msg({ id: 'm1', client_message_id: 'cli-1', body: 'Estou com sede.' });

    const r = mergeMessages([otimista], [doServidor]);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('m1');
  });

  it('ordena por created_at', () => {
    const r = mergeMessages(
      [msg({ id: 'c', client_message_id: 'x3', created_at: '2026-09-03T12:00:00.000Z' })],
      [
        msg({ id: 'a', client_message_id: 'x1', created_at: '2026-09-03T10:00:00.000Z' }),
        msg({ id: 'b', client_message_id: 'x2', created_at: '2026-09-03T11:00:00.000Z' }),
      ],
    );
    expect(r.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserva mensagens de broadcast em conversas diferentes', () => {
    // Mesmo client_message_id, conversas diferentes: são duas mensagens
    // legítimas, uma para cada cuidador.
    const r = mergeMessages(
      [msg({ id: 'm1', conversation_id: 'conv-1', client_message_id: 'cli-x' })],
      [msg({ id: 'm2', conversation_id: 'conv-2', client_message_id: 'cli-x' })],
    );
    expect(r).toHaveLength(2);
  });

  it('a versão mais recente do servidor vence a otimista', () => {
    const r = mergeMessages(
      [msg({ id: 'm1', body: 'texto local' })],
      [msg({ id: 'm1', body: 'texto do servidor' })],
    );
    expect(r[0]!.body).toBe('texto do servidor');
  });
});
