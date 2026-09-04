/**
 * Fila de saída persistente.
 *
 * Três invariantes que este arquivo existe para garantir:
 *
 *  1. Nada se perde. O item é gravado ANTES da primeira tentativa de envio.
 *     Se o app fechar, cair ou perder a rede entre o clique e a resposta, a
 *     mensagem continua lá no próximo boot.
 *
 *  2. Nada duplica. Todo item carrega um `clientId` gerado uma vez. O
 *     servidor faz `on conflict do nothing` sobre ele, então retentar é
 *     seguro — e retentar é o que a fila faz o tempo todo.
 *
 *  3. `sent` só com confirmação do servidor. É o §13 do briefing traduzido
 *     em código: a UI lê o estado daqui, e daqui nunca sai "enviado" sem
 *     resposta.
 *
 * O ponto sutil do item 2: um timeout NÃO significa que a mensagem não
 * chegou. Significa que a resposta não voltou. Sem a chave de idempotência,
 * a retentativa correta produziria duplicata — "Preciso de ajuda" três
 * vezes, e o cuidador achando que são três pedidos.
 */

import type { OutboxItem, StorageAdapter, UrgencyLevel } from './types';

const CHAVE = 'irisflow_outbox_v1';

/** 1s, 2s, 4s, 8s, 16s, depois 32s fixo. */
const BASE_MS = 1_000;
const TETO_MS = 32_000;

/**
 * Teto de tentativas por urgência.
 *
 * `emergencia` é `Infinity` de propósito: desistir de avisar que alguém está
 * passando mal porque a rede oscilou por vinte minutos é a decisão errada.
 * A fila insiste enquanto o alerta estiver ativo; quem encerra é o
 * cancelamento ou a confirmação, não um contador.
 */
const MAX_TENTATIVAS: Record<UrgencyLevel, number> = {
  normal: 8,
  importante: 12,
  urgente: 20,
  emergencia: Number.POSITIVE_INFINITY,
};

export interface SendResult {
  serverId: string;
}

/** Envia um item. Deve lançar `CommError` com `retryable` correto. */
export type Sender = (item: OutboxItem) => Promise<SendResult>;

export interface OutboxEvents {
  onChange?: (items: readonly OutboxItem[]) => void;
  onSent?: (item: OutboxItem) => void;
  onFailed?: (item: OutboxItem) => void;
}

export interface OutboxOptions {
  storage: StorageAdapter;
  send: Sender;
  now?: () => number;
  events?: OutboxEvents;
  /** Injetável para o teste não esperar de verdade. */
  schedule?: (fn: () => void, ms: number) => void;
}

export class Outbox {
  private items: OutboxItem[] = [];
  private carregado = false;
  private online = true;

  /**
   * Passagem de drenagem em andamento.
   *
   * Um booleano `drenando` seria mais simples e estaria errado: `enqueue`
   * dispara uma drenagem sem esperar por ela, então quem chamasse `drain()`
   * logo em seguida receberia o retorno imediato do guarda e leria o item
   * ainda em `sending`. Guardar a promessa faz o segundo chamador esperar a
   * primeira terminar, e `await drain()` passa a significar de verdade "a
   * fila foi processada".
   */
  private drenagem: Promise<void> | null = null;

  private readonly storage: StorageAdapter;
  private readonly send: Sender;
  private readonly now: () => number;
  private readonly events: OutboxEvents;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(opts: OutboxOptions) {
    this.storage = opts.storage;
    this.send = opts.send;
    this.now = opts.now ?? (() => Date.now());
    this.events = opts.events ?? {};
    this.schedule =
      opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  async load(): Promise<void> {
    if (this.carregado) return;
    try {
      const raw = await this.storage.getItem(CHAVE);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.items = Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
    } catch {
      // Storage corrompido não pode impedir o app de abrir. Perder a fila é
      // ruim; travar a tela de comunicação de quem precisa dela é pior.
      this.items = [];
    }

    // Duas recuperações de boot, ambas sobre o mesmo fato: o app reabriu.
    //
    //  - `sending` interrompido por um fechamento volta para `queued`. Sem
    //    isto, o item ficaria preso num estado que nada mais avança — e o
    //    `clientId` garante que reenviar não duplica.
    //
    //  - o backoff pendente é descartado. Ele foi calculado na sessão
    //    anterior, contra uma rede que já não é a mesma; fazer alguém que
    //    acabou de abrir o programa esperar 32 s por uma indisponibilidade
    //    de ontem seria punir pelo passado.
    let mexeu = false;
    for (const it of this.items) {
      if (it.state === 'sending') {
        it.state = 'queued';
        mexeu = true;
      }
      if (it.state === 'queued' && it.nextAttemptAt !== 0) {
        it.nextAttemptAt = 0;
        mexeu = true;
      }
    }
    this.carregado = true;
    if (mexeu) await this.persist();
  }

  /** Enfileira e persiste. Só depois tenta enviar. Nessa ordem. */
  async enqueue(
    item: Omit<OutboxItem, 'state' | 'attempts' | 'createdAt' | 'nextAttemptAt' | 'lastError' | 'serverId'>,
  ): Promise<OutboxItem> {
    await this.load();

    const existente = this.items.find((i) => i.clientId === item.clientId);
    if (existente) return existente;   // idempotente também na entrada

    const novo: OutboxItem = {
      ...item,
      state: 'queued',
      attempts: 0,
      createdAt: this.now(),
      nextAttemptAt: this.now(),
      lastError: null,
      serverId: null,
    };
    this.items.push(novo);
    await this.persist();
    void this.drain();
    return novo;
  }

  /**
   * Percorre a fila enviando o que estiver pronto.
   *
   * FIFO por conversa: itens da mesma conversa são enviados em ordem, para o
   * diálogo não embaralhar. Entre conversas diferentes a ordem não importa —
   * e serializar tudo faria uma conversa lenta atrasar as outras.
   */
  async drain(): Promise<void> {
    // Espera a passagem em curso terminar. Ela pode ter tirado a fotografia
    // da fila ANTES do item que acabou de ser enfileirado — devolver o
    // controle aqui deixaria esse item parado até a próxima drenagem
    // agendada, que no caso de um pedido de ajuda são segundos que não
    // existem para serem gastos.
    if (this.drenagem) await this.drenagem;
    if (!this.online) return;

    // Outra chamada assumiu a nova passagem enquanto esperávamos: a dela
    // começou depois da nossa, então cobre o que precisamos.
    if (this.drenagem) {
      await this.drenagem;
      return;
    }

    this.drenagem = this.executarPassagem().finally(() => {
      this.drenagem = null;
    });
    await this.drenagem;
  }

  private async executarPassagem(): Promise<void> {
    await this.load();

    const bloqueadas = new Set<string>();
    const agora = this.now();

    for (const item of [...this.items]) {
      if (item.state === 'sent' || item.state === 'failed') continue;

      const fio = item.conversationId ?? item.patientId ?? '__global__';
      if (bloqueadas.has(fio)) continue;

      if (item.nextAttemptAt > agora) {
        // Já agendado: nada depois dele nesta conversa pode passar na
        // frente, senão a ordem quebra.
        bloqueadas.add(fio);
        continue;
      }

      const ok = await this.tentar(item);
      if (!ok) bloqueadas.add(fio);
    }
  }

  private async tentar(item: OutboxItem): Promise<boolean> {
    item.state = 'sending';
    item.attempts += 1;
    await this.persist();

    try {
      const { serverId } = await this.send(item);
      item.state = 'sent';
      item.serverId = serverId;
      item.lastError = null;
      await this.persist();
      this.events.onSent?.(item);
      return true;
    } catch (err) {
      const e = err as { retryable?: boolean; message?: string; code?: string };
      item.lastError = e?.message ?? 'erro desconhecido';

      const podeRetentar = e?.retryable !== false;
      const teto = MAX_TENTATIVAS[item.urgency] ?? 8;

      if (!podeRetentar || item.attempts >= teto) {
        // Erro definitivo (403, permissão) ou tentativas esgotadas. Marcar
        // `failed` é o que faz a interface poder dizer a verdade em vez de
        // manter um spinner eterno.
        item.state = 'failed';
        await this.persist();
        this.events.onFailed?.(item);
        return false;
      }

      item.state = 'queued';
      item.nextAttemptAt = this.now() + this.backoff(item.attempts);
      await this.persist();
      this.schedule(() => void this.drain(), this.backoff(item.attempts));
      return false;
    }
  }

  /**
   * Backoff exponencial com jitter.
   *
   * O jitter não é enfeite: sem ele, todos os dispositivos que perderam a
   * conexão na mesma queda de servidor retentam no mesmo milissegundo e
   * derrubam o servidor de novo assim que ele volta.
   */
  private backoff(tentativa: number): number {
    const base = Math.min(BASE_MS * 2 ** (tentativa - 1), TETO_MS);
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  /**
   * Sinal de conectividade.
   *
   * Voltar a ficar online drena imediatamente, ignorando o backoff pendente:
   * o backoff existe para não martelar um servidor indisponível, e a rede
   * acabou de voltar. Esperar 32 s depois disso seria punir o usuário por
   * uma espera que já terminou.
   */
  setOnline(online: boolean): void {
    const voltou = online && !this.online;
    this.online = online;
    if (!voltou) return;

    for (const it of this.items) {
      if (it.state === 'queued') it.nextAttemptAt = 0;
    }
    void this.drain();
  }

  /** Reenvia um item que já falhou, zerando o contador. */
  async retry(clientId: string): Promise<void> {
    await this.load();
    const item = this.items.find((i) => i.clientId === clientId);
    if (!item || item.state === 'sent') return;
    item.state = 'queued';
    item.attempts = 0;
    item.nextAttemptAt = 0;
    item.lastError = null;
    await this.persist();
    void this.drain();
  }

  /** Remove os enviados. Chamada após a UI confirmar que os exibiu. */
  async prune(): Promise<void> {
    await this.load();
    const antes = this.items.length;
    this.items = this.items.filter((i) => i.state !== 'sent');
    if (this.items.length !== antes) await this.persist();
  }

  pending(): readonly OutboxItem[] {
    return this.items.filter((i) => i.state === 'queued' || i.state === 'sending');
  }

  failed(): readonly OutboxItem[] {
    return this.items.filter((i) => i.state === 'failed');
  }

  all(): readonly OutboxItem[] {
    return [...this.items];
  }

  find(clientId: string): OutboxItem | undefined {
    return this.items.find((i) => i.clientId === clientId);
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.setItem(CHAVE, JSON.stringify(this.items));
    } catch {
      // Storage cheio. A fila segue em memória — degradada, mas viva.
    }
    this.events.onChange?.([...this.items]);
  }
}
