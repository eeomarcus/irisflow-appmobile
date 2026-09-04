/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  FERRAMENTA DE DESENVOLVIMENTO — NUNCA ENTRA EM PRODUÇÃO             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Cliente Supabase falso, em memória, para ver as telas sem servidor.
 *
 * Existe porque avaliar a interface não deveria exigir provisionar um banco,
 * criar contas e parear um paciente. Mas o §25.8 do briefing é explícito —
 * *"não use mocks como solução final"* — então este arquivo tem três travas:
 *
 *   1. Só é importado quando `EXPO_PUBLIC_PREVIEW=1`.
 *   2. `assertPreviewSafe()` lança se rodar fora de `__DEV__`.
 *   3. O app mostra uma tarja permanente enquanto o modo estiver ligado.
 *
 * A escolha de fingir o CLIENTE, e não as telas, é deliberada: `PatientsScreen`,
 * `ConversationScreen` e `EmergencyScreen` rodam sem uma linha alterada. O que
 * você vê é o componente real, com o layout real, os estados reais de entrega
 * e a mesma máquina de estados da emergência. Se eu tivesse feito telas de
 * demonstração separadas, a demonstração poderia estar certa e o produto
 * errado.
 *
 * O que ele NÃO simula, de propósito: push notification. O §8 proíbe
 * notificação falsa, e nenhuma tarja deixaria essa em particular segura —
 * alguém acabaria concluindo que os alertas funcionam.
 */

import type { EmergencyAlert, Message } from '@irisflow/comm-client';

export function assertPreviewSafe(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(globalThis as any).__DEV__) {
    throw new Error(
      'Modo de pré-visualização não pode rodar em build de produção. ' +
        'Remova EXPO_PUBLIC_PREVIEW do ambiente.',
    );
  }
}

const AGORA = Date.now();
const min = (m: number) => new Date(AGORA - m * 60_000).toISOString();

const PACIENTE_1 = 'p-marta-0000-0000-000000000001';
const PACIENTE_2 = 'p-joao-0000-0000-000000000002';
const CONVERSA_1 = 'c-0000-0000-0000-000000000001';
const CONVERSA_2 = 'c-0000-0000-0000-000000000002';
const CUIDADOR = 'u-0000-0000-0000-00000000000c';

/** Nomes fictícios. Nenhum dado real, conforme o §23. */
const conversas = [
  {
    conversation_id: CONVERSA_1,
    patient_id: PACIENTE_1,
    caregiver_user_id: CUIDADOR,
    patient_name: 'Marta (exemplo)',
    last_message_at: min(3),
    patient_status: 'online' as const,
    irisflow_running: true,
    last_seen_at: min(1),
    last_message_body: 'Estou com dor.',
    last_message_sender: 'patient' as const,
    last_message_urgency: 'urgente' as const,
    unread_count: 2,
    active_alert_id: null as string | null,
    active_alert_state: null as EmergencyAlert['state'] | null,
    active_alert_at: null as string | null,
  },
  {
    conversation_id: CONVERSA_2,
    patient_id: PACIENTE_2,
    caregiver_user_id: CUIDADOR,
    patient_name: 'João (exemplo)',
    last_message_at: min(140),
    patient_status: 'offline' as const,
    irisflow_running: false,
    last_seen_at: min(140),
    last_message_body: 'Obrigado.',
    last_message_sender: 'patient' as const,
    last_message_urgency: 'normal' as const,
    unread_count: 0,
    active_alert_id: null as string | null,
    active_alert_state: null as EmergencyAlert['state'] | null,
    active_alert_at: null as string | null,
  },
];

function msg(over: Partial<Message> & { id: string }): Message {
  return {
    conversation_id: CONVERSA_1,
    client_message_id: `cli-${over.id}`,
    sender_kind: 'patient',
    sender_user_id: null,
    kind: 'quick_phrase',
    urgency: 'normal',
    body: '',
    created_at: min(60),
    server_received_at: min(60),
    deleted_at: null,
    ...over,
  } as Message;
}

const mensagens: Message[] = [
  msg({ id: 'm1', body: 'Preciso ir ao banheiro.', urgency: 'importante', created_at: min(52), server_received_at: min(52) }),
  msg({ id: 'm2', body: 'Estou indo aí.', sender_kind: 'caregiver', sender_user_id: CUIDADOR, created_at: min(50), server_received_at: min(50) }),
  msg({ id: 'm3', body: 'Obrigado.', created_at: min(44), server_received_at: min(44) }),
  msg({ id: 'm4', body: 'Quero mudar de posição.', urgency: 'importante', created_at: min(20), server_received_at: min(20) }),
  msg({ id: 'm5', body: 'Já vou, um minuto.', sender_kind: 'caregiver', sender_user_id: CUIDADOR, created_at: min(18), server_received_at: min(18) }),
  msg({ id: 'm6', body: 'Estou com dor.', urgency: 'urgente', created_at: min(3), server_received_at: min(3) }),
];

const alertas: EmergencyAlert[] = [];

/**
 * Assinantes de tempo real.
 *
 * A emergência de demonstração usa isto para empurrar as transições de
 * estado exatamente como o Postgres empurraria, para a tela reagir do mesmo
 * jeito que reagiria em produção.
 */
type Ouvinte = (payload: { new: unknown; old: unknown }) => void;
const ouvintes = new Map<string, Ouvinte[]>();

function emitir(tabela: string, linha: unknown): void {
  for (const fn of ouvintes.get(tabela) ?? []) fn({ new: linha, old: null });
}

/**
 * Dispara uma emergência de exemplo e roda o ciclo de vida dela.
 *
 * Chamado pelo botão da tarja de pré-visualização. Não avança sozinho para
 * CONFIRMADO: quem confirma é você, tocando no botão da tela — é justamente
 * essa transição que vale a pena ver.
 */
export function simularEmergencia(): string {
  const id = `a-${Date.now()}`;
  const alerta: EmergencyAlert = {
    id,
    patient_id: PACIENTE_1,
    client_alert_id: `cli-${id}`,
    category: 'pain',
    state: 'ALERTA_DISPARADO',
    note: null,
    triggered_at: new Date().toISOString(),
    delivered_at: null,
    seen_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    cancelled_at: null,
    failed_at: null,
    failure_reason: null,
    escalation_level: 0,
  };
  alertas.unshift(alerta);

  const c = conversas[0]!;
  c.active_alert_id = id;
  c.active_alert_state = 'ALERTA_DISPARADO';
  c.active_alert_at = alerta.triggered_at;

  emitir('emergency_alerts', alerta);
  return id;
}

export function limparEmergencias(): void {
  alertas.length = 0;
  const c = conversas[0]!;
  c.active_alert_id = null;
  c.active_alert_state = null;
  c.active_alert_at = null;
}

/** Builder encadeável, com a mesma forma "thenable" do supabase-js. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function builder(linhas: any[]): any {
  let atual = [...linhas];
  const b: Record<string, unknown> = {};

  const filtro = (nome: string) => (coluna: string, valor: unknown) => {
    if (nome === 'eq') atual = atual.filter((l) => l[coluna] === valor);
    if (nome === 'in') atual = atual.filter((l) => (valor as unknown[]).includes(l[coluna]));
    if (nome === 'is') atual = atual.filter((l) => l[coluna] === valor);
    if (nome === 'gt') atual = atual.filter((l) => String(l[coluna]) > String(valor));
    if (nome === 'lt') atual = atual.filter((l) => String(l[coluna]) < String(valor));
    return b;
  };

  for (const f of ['eq', 'in', 'is', 'gt', 'lt']) b[f] = filtro(f);

  b.select = () => b;
  b.update = () => b;
  b.maybeSingle = async () => ({ data: atual[0] ?? null, error: null });
  b.single = async () => ({ data: atual[0] ?? null, error: null });

  b.order = (coluna: string, opts?: { ascending?: boolean }) => {
    const asc = opts?.ascending !== false;
    atual.sort((x, y) => {
      const a = String(x[coluna] ?? '');
      const c = String(y[coluna] ?? '');
      return asc ? a.localeCompare(c) : c.localeCompare(a);
    });
    return b;
  };

  b.limit = (n: number) => {
    atual = atual.slice(0, n);
    return b;
  };

  b.then = (res: (v: unknown) => unknown) => res({ data: atual, error: null });
  return b;
}

/**
 * Cliente falso. Implementa só a superfície que as telas realmente tocam —
 * `from`, `rpc`, `channel`, `removeChannel` e `auth`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function criarSupabaseFalso(): any {
  return {
    from(tabela: string) {
      switch (tabela) {
        case 'v_caregiver_conversations': return builder(conversas);
        case 'messages': return builder(mensagens);
        case 'emergency_alerts': return builder(alertas);
        default: return builder([]);
      }
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rpc(nome: string, args: any) {
      switch (nome) {
        case 'send_message': {
          const nova = msg({
            id: `m-${Date.now()}`,
            conversation_id: args.p_conversation_id,
            client_message_id: args.p_client_message_id,
            sender_kind: 'caregiver',
            sender_user_id: CUIDADOR,
            kind: args.p_kind,
            urgency: args.p_urgency,
            body: args.p_body,
            created_at: new Date().toISOString(),
            server_received_at: new Date().toISOString(),
          });
          // Idempotência de verdade, como no RPC real: reenviar o mesmo
          // client_message_id devolve a linha existente.
          const existente = mensagens.find(
            (m) => m.client_message_id === args.p_client_message_id,
          );
          if (existente) return { data: existente, error: null };

          // Meio segundo de latência simulada — é o intervalo em que o balão
          // fica cinza com "enviando…". Sem ele, o estado que este projeto
          // mais insiste em mostrar corretamente passaria despercebido.
          await new Promise((r) => setTimeout(r, 500));
          mensagens.push(nova);
          emitir('messages', nova);
          return { data: nova, error: null };
        }

        case 'mark_emergency_seen':
        case 'acknowledge_emergency': {
          const a = alertas.find((x) => x.id === args.p_alert_id);
          if (!a) return { data: null, error: { code: '42501', message: 'alerta inacessivel' } };

          if (nome === 'mark_emergency_seen') {
            a.state = 'VISUALIZADO';
            a.delivered_at ??= new Date().toISOString();
            a.seen_at ??= new Date().toISOString();
          } else {
            a.state = 'CONFIRMADO';
            a.acknowledged_at = new Date().toISOString();
            a.acknowledged_by = CUIDADOR;
            const c = conversas[0]!;
            c.active_alert_id = null;
            c.active_alert_state = null;
          }
          emitir('emergency_alerts', a);
          return { data: a, error: null };
        }

        case 'mark_messages_read':
        case 'mark_messages_delivered':
          conversas[0]!.unread_count = 0;
          return { data: 0, error: null };

        // register_push_token cai aqui e devolve erro de propósito: a tarja
        // de status da PatientsScreen precisa mostrar que push não funciona
        // em pré-visualização, em vez de fingir que sim (§8).
        default:
          return { data: null, error: { code: 'PREVIEW', message: 'indisponível na pré-visualização' } };
      }
    },

    channel(nome: string) {
      const ch = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        on(_tipo: string, cfg: any, fn: Ouvinte) {
          const lista = ouvintes.get(cfg.table) ?? [];
          lista.push(fn);
          ouvintes.set(cfg.table, lista);
          return ch;
        },
        subscribe(cb?: (s: string) => void) {
          setTimeout(() => cb?.('SUBSCRIBED'), 50);
          return ch;
        },
        nome,
      };
      return ch;
    },

    async removeChannel() {
      return 'ok';
    },

    auth: {
      async getSession() {
        return {
          data: {
            session: {
              access_token: 'preview',
              user: { id: CUIDADOR, email: 'preview@exemplo.invalid' },
            },
          },
          error: null,
        };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithPassword() {
        return { data: {}, error: null };
      },
      async signOut() {
        return { error: null };
      },
      async resetPasswordForEmail() {
        return { data: {}, error: null };
      },
    },
  };
}
