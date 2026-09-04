import { describe, expect, it, vi } from 'vitest';
import { Outbox } from './outbox';
import { memoryStorage } from './client';
import type { OutboxItem, StorageAdapter, UrgencyLevel } from './types';

/** Storage compartilhável entre duas instâncias — simula reabrir o app. */
function storagePersistente() {
  const mapa = new Map<string, string>();
  const adapter: StorageAdapter = {
    getItem: async (k) => mapa.get(k) ?? null,
    setItem: async (k, v) => void mapa.set(k, v),
    removeItem: async (k) => void mapa.delete(k),
  };
  return { adapter, mapa };
}

function item(
  clientId: string,
  urgency: UrgencyLevel = 'normal',
  conversationId = 'conv-1',
): Omit<OutboxItem, 'state' | 'attempts' | 'createdAt' | 'nextAttemptAt' | 'lastError' | 'serverId'> {
  return {
    clientId,
    conversationId,
    patientId: null,
    body: 'Preciso de ajuda.',
    kind: 'quick_phrase',
    urgency,
  };
}

/**
 * Relógio controlado pelo teste.
 *
 * O outbox agenda a retentativa em `now() + backoff`. Em vez de esperar o
 * backoff de verdade (ou de simular o agendador, que esconderia o cálculo do
 * backoff em vez de exercitá-lo), o teste avança o relógio e drena de novo.
 */
function relogio(inicio = 1_000_000) {
  let t = inicio;
  return { now: () => t, avancar: (ms: number) => { t += ms; } };
}

/** Drena repetidamente, avançando o relógio para vencer cada backoff. */
async function drenarAte(
  ob: Outbox,
  clock: { avancar: (ms: number) => void },
  passos = 40,
): Promise<void> {
  for (let i = 0; i < passos; i += 1) {
    await ob.drain();
    clock.avancar(60_000);
  }
}

/** O teste controla quando drenar; o agendador interno não faz nada. */
const semAgendamento = () => {};

const erroDeRede = () =>
  Object.assign(new Error('network down'), { retryable: true });
const erroDePermissao = () =>
  Object.assign(new Error('conversa inacessivel'), { retryable: false });

describe('Outbox', () => {
  it('persiste antes de tentar enviar — nada se perde se o app fechar', async () => {
    const { adapter, mapa } = storagePersistente();
    let gravadoQuandoEnviou: string | null = null;

    const send = vi.fn(async () => {
      // No instante do envio, o item já tem que estar no disco.
      gravadoQuandoEnviou = mapa.get('irisflow_outbox_v1') ?? null;
      return { serverId: 'srv-1' };
    });

    const ob = new Outbox({ storage: adapter, send, schedule: semAgendamento });
    await ob.enqueue(item('c1'));
    await ob.drain();

    expect(gravadoQuandoEnviou).toBeTruthy();
    expect(gravadoQuandoEnviou).toContain('c1');
  });

  it('não marca "sent" sem confirmação do servidor', async () => {
    const send = vi.fn(async () => {
      throw erroDeRede();
    });
    const ob = new Outbox({
      storage: memoryStorage(),
      send,
      schedule: () => {},   // não retenta neste teste
    });

    await ob.enqueue(item('c1'));
    await ob.drain();

    const it1 = ob.find('c1');
    // O invariante: sem resposta do servidor, o item NUNCA chega a 'sent'.
    expect(it1?.state).toBe('queued');
    expect(it1?.serverId).toBeNull();
    expect(ob.all().some((i) => i.state === 'sent')).toBe(false);
  });

  it('marca "sent" e guarda o id do servidor quando confirma', async () => {
    const ob = new Outbox({
      storage: memoryStorage(),
      send: async () => ({ serverId: 'srv-42' }),
      schedule: semAgendamento,
    });

    await ob.enqueue(item('c1'));
    await ob.drain();

    expect(ob.find('c1')?.state).toBe('sent');
    expect(ob.find('c1')?.serverId).toBe('srv-42');
    expect(ob.pending()).toHaveLength(0);
  });

  it('não duplica ao enfileirar o mesmo clientId duas vezes', async () => {
    const send = vi.fn(async () => ({ serverId: 'srv-1' }));
    const ob = new Outbox({ storage: memoryStorage(), send, schedule: semAgendamento });

    await ob.enqueue(item('mesmo-id'));
    await ob.enqueue(item('mesmo-id'));
    await ob.drain();

    expect(ob.all()).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retenta com o MESMO clientId — é o que torna o reenvio seguro', async () => {
    const vistos: string[] = [];
    let falhas = 2;
    const send = vi.fn(async (i: OutboxItem) => {
      vistos.push(i.clientId);
      if (falhas-- > 0) throw erroDeRede();
      return { serverId: 'srv-1' };
    });

    const clock = relogio();
    const ob = new Outbox({
      storage: memoryStorage(), send, now: clock.now, schedule: semAgendamento,
    });
    await ob.enqueue(item('c1'));
    await drenarAte(ob, clock);

    expect(vistos.length).toBeGreaterThanOrEqual(3);
    // Todas as tentativas carregam a mesma chave de idempotência: o servidor
    // colapsa em uma linha só.
    expect(new Set(vistos).size).toBe(1);
    expect(ob.find('c1')?.state).toBe('sent');
  });

  it('desiste na hora em erro não retentável (403) em vez de martelar', async () => {
    const send = vi.fn(async () => {
      throw erroDePermissao();
    });
    const ob = new Outbox({ storage: memoryStorage(), send, schedule: semAgendamento });

    await ob.enqueue(item('c1'));
    await ob.drain();

    expect(send).toHaveBeenCalledTimes(1);
    expect(ob.find('c1')?.state).toBe('failed');
    expect(ob.failed()).toHaveLength(1);
  });

  it('marca "failed" ao esgotar as tentativas de uma mensagem comum', async () => {
    const send = vi.fn(async () => {
      throw erroDeRede();
    });
    const clock = relogio();
    const ob = new Outbox({
      storage: memoryStorage(), send, now: clock.now, schedule: semAgendamento,
    });

    await ob.enqueue(item('c1', 'normal'));
    await drenarAte(ob, clock);

    expect(ob.find('c1')?.state).toBe('failed');
    expect(send).toHaveBeenCalledTimes(8);   // teto de 'normal'
  });

  it('não desiste de uma emergência — o teto é infinito de propósito', async () => {
    let tentativas = 0;
    const send = vi.fn(async () => {
      tentativas += 1;
      if (tentativas < 25) throw erroDeRede();
      return { serverId: 'srv-emerg' };
    });

    const clock = relogio();
    const ob = new Outbox({
      storage: memoryStorage(), send, now: clock.now, schedule: semAgendamento,
    });
    await ob.enqueue(item('c1', 'emergencia'));
    await drenarAte(ob, clock, 30);

    // 25 tentativas passa muito do teto de 'urgente' (20). Uma emergência que
    // desistisse por causa de vinte minutos de rede ruim seria o pior defeito
    // possível deste sistema.
    expect(ob.find('c1')?.state).toBe('sent');
    expect(tentativas).toBe(25);
  });

  it('sobrevive ao fechamento do app e volta a enviar no próximo boot', async () => {
    const { adapter } = storagePersistente();

    const ob1 = new Outbox({
      storage: adapter,
      send: async () => {
        throw erroDeRede();
      },
      schedule: () => {},
    });
    await ob1.enqueue(item('c1'));
    await ob1.drain();
    expect(ob1.find('c1')?.state).toBe('queued');

    // Nova instância, mesmo storage: o app reabriu.
    const send2 = vi.fn(async () => ({ serverId: 'srv-1' }));
    const ob2 = new Outbox({ storage: adapter, send: send2, schedule: semAgendamento });
    await ob2.load();

    expect(ob2.find('c1')).toBeDefined();
    await ob2.drain();
    expect(ob2.find('c1')?.state).toBe('sent');
  });

  it('destrava um "sending" interrompido por um fechamento abrupto', async () => {
    const { adapter, mapa } = storagePersistente();
    // Simula o app tendo morrido no meio de um envio.
    mapa.set(
      'irisflow_outbox_v1',
      JSON.stringify([
        {
          ...item('c1'),
          state: 'sending',
          attempts: 1,
          createdAt: 0,
          nextAttemptAt: 0,
          lastError: null,
          serverId: null,
        },
      ]),
    );

    const send = vi.fn(async () => ({ serverId: 'srv-1' }));
    const ob = new Outbox({ storage: adapter, send, schedule: semAgendamento });
    await ob.load();

    // Sem esta recuperação, o item ficaria preso para sempre num estado que
    // nada mais avança.
    expect(ob.find('c1')?.state).toBe('queued');
    await ob.drain();
    expect(ob.find('c1')?.state).toBe('sent');
  });

  it('mantém a ordem dentro de uma conversa quando a primeira falha', async () => {
    const enviados: string[] = [];
    let primeiraFalhou = false;
    const send = vi.fn(async (i: OutboxItem) => {
      if (i.clientId === 'c1' && !primeiraFalhou) {
        primeiraFalhou = true;
        throw erroDeRede();
      }
      enviados.push(i.clientId);
      return { serverId: `srv-${i.clientId}` };
    });

    const ob = new Outbox({ storage: memoryStorage(), send, schedule: () => {} });
    await ob.enqueue(item('c1'));
    await ob.enqueue(item('c2'));
    await ob.drain();

    // c2 não pode ultrapassar c1: o diálogo apareceria fora de ordem para o
    // cuidador.
    expect(enviados).not.toContain('c2');
  });

  it('não deixa uma conversa travada bloquear as outras', async () => {
    const enviados: string[] = [];
    const send = vi.fn(async (i: OutboxItem) => {
      if (i.conversationId === 'conv-travada') throw erroDeRede();
      enviados.push(i.clientId);
      return { serverId: 'srv' };
    });

    const ob = new Outbox({ storage: memoryStorage(), send, schedule: () => {} });
    await ob.enqueue(item('travado', 'normal', 'conv-travada'));
    await ob.enqueue(item('livre', 'normal', 'conv-ok'));
    await ob.drain();

    expect(enviados).toEqual(['livre']);
  });

  it('não envia enquanto offline e drena assim que a rede volta', async () => {
    const send = vi.fn(async () => ({ serverId: 'srv-1' }));
    const ob = new Outbox({ storage: memoryStorage(), send, schedule: semAgendamento });

    ob.setOnline(false);
    await ob.enqueue(item('c1'));
    await ob.drain();
    expect(send).not.toHaveBeenCalled();
    expect(ob.find('c1')?.state).toBe('queued');

    ob.setOnline(true);
    await ob.drain();
    expect(ob.find('c1')?.state).toBe('sent');
  });

  it('voltar online ignora o backoff pendente', async () => {
    let falhar = true;
    const send = vi.fn(async () => {
      if (falhar) throw erroDeRede();
      return { serverId: 'srv-1' };
    });

    const agora = 1_000_000;
    const ob = new Outbox({
      storage: memoryStorage(),
      send,
      now: () => agora,
      schedule: () => {},
    });

    await ob.enqueue(item('c1'));
    await ob.drain();
    expect(ob.find('c1')!.nextAttemptAt).toBeGreaterThan(agora);

    // A rede voltou. Esperar os 32 s de backoff seria punir o usuário por uma
    // espera que já terminou.
    falhar = false;
    ob.setOnline(false);
    ob.setOnline(true);
    await ob.drain();

    expect(ob.find('c1')?.state).toBe('sent');
  });

  it('retry() zera o contador de um item que já falhou', async () => {
    let falhar = true;
    const send = vi.fn(async () => {
      if (falhar) throw erroDePermissao();
      return { serverId: 'srv-1' };
    });

    const clock = relogio();
    const ob = new Outbox({
      storage: memoryStorage(), send, now: clock.now, schedule: semAgendamento,
    });
    await ob.enqueue(item('c1'));
    await ob.drain();
    expect(ob.find('c1')?.state).toBe('failed');

    falhar = false;
    await ob.retry('c1');
    await ob.drain();

    expect(ob.find('c1')?.state).toBe('sent');
    expect(ob.find('c1')?.attempts).toBe(1);
  });

  it('prune() remove só os enviados', async () => {
    let falhar = false;
    const send = vi.fn(async () => {
      if (falhar) throw erroDePermissao();
      return { serverId: 'srv' };
    });
    const ob = new Outbox({ storage: memoryStorage(), send, schedule: semAgendamento });

    await ob.enqueue(item('enviado'));
    await ob.drain();
    falhar = true;
    await ob.enqueue(item('falhou', 'normal', 'conv-2'));
    await ob.drain();

    await ob.prune();

    expect(ob.find('enviado')).toBeUndefined();
    expect(ob.find('falhou')?.state).toBe('failed');
  });

  it('storage corrompido não impede o app de abrir', async () => {
    const { adapter, mapa } = storagePersistente();
    mapa.set('irisflow_outbox_v1', '{isto não é json válido');

    const ob = new Outbox({
      storage: adapter,
      send: async () => ({ serverId: 'srv' }),
      schedule: semAgendamento,
    });

    await expect(ob.load()).resolves.toBeUndefined();
    expect(ob.all()).toEqual([]);
    await ob.enqueue(item('c1'));
    await ob.drain();
    expect(ob.find('c1')?.state).toBe('sent');
  });

  it('emite onSent e onFailed para a interface refletir o estado real', async () => {
    const onSent = vi.fn();
    const onFailed = vi.fn();
    let falhar = false;

    const ob = new Outbox({
      storage: memoryStorage(),
      send: async () => {
        if (falhar) throw erroDePermissao();
        return { serverId: 'srv' };
      },
      schedule: semAgendamento,
      events: { onSent, onFailed },
    });

    await ob.enqueue(item('ok'));
    await ob.drain();
    falhar = true;
    await ob.enqueue(item('ruim', 'normal', 'conv-2'));
    await ob.drain();

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});
