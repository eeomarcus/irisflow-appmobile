import { describe, expect, it, vi } from 'vitest';
import {
  EmergencyController,
  canTransition,
  describeState,
  isUnresolved,
  triggerEmergency,
  acknowledgeEmergency,
} from './emergency';
import type { EmergencyAlert, EmergencyState } from './types';

function alerta(over: Partial<EmergencyAlert> = {}): EmergencyAlert {
  return {
    id: 'alert-1',
    patient_id: 'pac-1',
    client_alert_id: 'cli-1',
    category: 'other',
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
    ...over,
  };
}

/** Stub mínimo de SupabaseClient: só o `rpc`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function supabaseFake(rpc: (nome: string, args: any) => Promise<any>): any {
  return { rpc: vi.fn(rpc) };
}

/** Retentativa sem espera real: o laço do controlador roda na velocidade do teste. */
const semEspera = async () => {};

describe('máquina de estados da emergência', () => {
  it('avança pelo caminho feliz do §20', () => {
    expect(canTransition('ENVIANDO', 'ALERTA_DISPARADO')).toBe(true);
    expect(canTransition('ALERTA_DISPARADO', 'ENTREGUE')).toBe(true);
    expect(canTransition('ENTREGUE', 'VISUALIZADO')).toBe(true);
    expect(canTransition('VISUALIZADO', 'CONFIRMADO')).toBe(true);
  });

  it('nunca regride', () => {
    // Regredir faria "Seu cuidador confirmou" sumir da tela do paciente.
    expect(canTransition('CONFIRMADO', 'ENTREGUE')).toBe(false);
    expect(canTransition('CONFIRMADO', 'ALERTA_DISPARADO')).toBe(false);
    expect(canTransition('VISUALIZADO', 'ENTREGUE')).toBe(false);
    expect(canTransition('ENTREGUE', 'ALERTA_DISPARADO')).toBe(false);
  });

  it('trata CONFIRMADO e CANCELADO como terminais', () => {
    expect(canTransition('CONFIRMADO', 'CANCELADO')).toBe(false);
    expect(canTransition('CANCELADO', 'CONFIRMADO')).toBe(false);
  });

  it('permite pular ENTREGUE — realtime e push podem chegar fora de ordem', () => {
    // O cuidador abriu o app direto pela notificação: VISUALIZADO chega sem
    // que ENTREGUE tenha sido registrado antes.
    expect(canTransition('ALERTA_DISPARADO', 'VISUALIZADO')).toBe(true);
    expect(canTransition('ALERTA_DISPARADO', 'CONFIRMADO')).toBe(true);
  });

  it('é idempotente: reaplicar o mesmo estado é permitido', () => {
    const estados: EmergencyState[] = [
      'ENVIANDO', 'ALERTA_DISPARADO', 'ENTREGUE',
      'VISUALIZADO', 'CONFIRMADO', 'CANCELADO', 'FALHA_DE_ENVIO',
    ];
    for (const e of estados) expect(canTransition(e, e)).toBe(true);
  });

  it('deixa uma retentativa tardia resgatar um FALHA_DE_ENVIO', () => {
    expect(canTransition('FALHA_DE_ENVIO', 'ALERTA_DISPARADO')).toBe(true);
  });

  it('classifica corretamente o que ainda não foi assumido', () => {
    expect(isUnresolved('ENVIANDO')).toBe(true);
    expect(isUnresolved('ALERTA_DISPARADO')).toBe(true);
    expect(isUnresolved('ENTREGUE')).toBe(true);
    // Ter visto não é ter assumido — por isso o escalonamento continua.
    expect(isUnresolved('VISUALIZADO')).toBe(true);
    expect(isUnresolved('CONFIRMADO')).toBe(false);
    expect(isUnresolved('CANCELADO')).toBe(false);
  });
});

describe('describeState — a interface não pode mentir (§13)', () => {
  it('não afirma entrega antes da confirmação do servidor', () => {
    for (const e of ['ENVIANDO', 'ALERTA_DISPARADO'] as EmergencyState[]) {
      const d = describeState(e);
      expect(d.title.toLowerCase()).not.toContain('recebeu');
      expect(d.title.toLowerCase()).not.toContain('enviado');
    }
  });

  it('só diz "recebeu" quando o app do cuidador confirmou', () => {
    expect(describeState('ENTREGUE').title).toContain('recebeu');
  });

  it('diz a verdade quando a rede falhou, e aponta o que ainda funciona', () => {
    const d = describeState('FALHA_DE_ENVIO');
    expect(d.title).toContain('Não consegui avisar');
    expect(d.detail).toContain('alarme sonoro');
    expect(d.tone).toBe('bad');
    // O alarme é a única camada que sobra: não pode parar.
    expect(d.keepAlarm).toBe(true);
  });

  it('mantém o alarme em todo estado não resolvido', () => {
    const naoResolvidos: EmergencyState[] = [
      'ENVIANDO', 'ALERTA_DISPARADO', 'ENTREGUE', 'VISUALIZADO', 'FALHA_DE_ENVIO',
    ];
    for (const e of naoResolvidos) expect(describeState(e).keepAlarm).toBe(true);
  });

  it('só silencia o alarme quando alguém assumiu ou o paciente cancelou', () => {
    expect(describeState('CONFIRMADO').keepAlarm).toBe(false);
    expect(describeState('CANCELADO').keepAlarm).toBe(false);
  });
});

describe('EmergencyController', () => {
  it('dispara o alarme local ANTES de qualquer chamada de rede', async () => {
    const ordem: string[] = [];
    const supabase = supabaseFake(async () => {
      ordem.push('rede');
      return { data: alerta(), error: null };
    });

    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => ordem.push('alarme'),
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1', 'pain');
    expect(ordem[0]).toBe('alarme');
  });

  it('sem backend configurado: alarme toca e o estado é FALHA_DE_ENVIO', async () => {
    const startLocalAlarm = vi.fn();
    const estados: EmergencyState[] = [];

    const c = new EmergencyController({
      supabase: null,          // é o estado atual do Blinkv1: nenhum backend
      patientId: null,
      startLocalAlarm,
      stopLocalAlarm: () => {},
      onStateChange: (s) => estados.push(s),
      delay: semEspera,
    });

    await c.trigger('cli-1');

    expect(startLocalAlarm).toHaveBeenCalledTimes(1);
    expect(c.getState()).toBe('FALHA_DE_ENVIO');
    // Nunca passou por um estado que sugerisse entrega.
    expect(estados).not.toContain('ENTREGUE');
    expect(describeState(c.getState()).keepAlarm).toBe(true);
  });

  it('chega a ALERTA_DISPARADO quando o servidor confirma', async () => {
    const supabase = supabaseFake(async () => ({ data: alerta(), error: null }));
    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');
    expect(c.getState()).toBe('ALERTA_DISPARADO');
    expect(c.getAlert()?.id).toBe('alert-1');
  });

  it('retenta com o mesmo client_alert_id e converge para um alerta só', async () => {
    const ids: string[] = [];
    let falhas = 3;
    const supabase = supabaseFake(async (_nome, args) => {
      ids.push(args.p_client_alert_id);
      if (falhas-- > 0) return { data: null, error: { message: 'rede', status: 503 } };
      return { data: alerta(), error: null };
    });

    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-unico');

    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(1);   // idempotência ponta a ponta
    expect(c.getState()).toBe('ALERTA_DISPARADO');
  });

  it('não retenta erro de permissão — vai direto para FALHA_DE_ENVIO', async () => {
    let chamadas = 0;
    const supabase = supabaseFake(async () => {
      chamadas += 1;
      return { data: null, error: { code: '42501', message: 'paciente inacessivel' } };
    });

    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');

    expect(chamadas).toBe(1);
    expect(c.getState()).toBe('FALHA_DE_ENVIO');
  });

  it('declara FALHA_DE_ENVIO ao esgotar a janela de envio', async () => {
    let agora = 0;
    const supabase = supabaseFake(async () => ({
      data: null,
      error: { message: 'timeout', status: 0 },
    }));

    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      now: () => agora,
      // Cada espera avança o relógio: a janela de 2 minutos fecha.
      delay: async () => {
        agora += 30_000;
      },
      maxSendWindowMs: 120_000,
    });

    await c.trigger('cli-1');
    expect(c.getState()).toBe('FALHA_DE_ENVIO');
  });

  it('mantém o alarme tocando em FALHA_DE_ENVIO', async () => {
    const stopLocalAlarm = vi.fn();
    const c = new EmergencyController({
      supabase: null,
      patientId: null,
      startLocalAlarm: () => {},
      stopLocalAlarm,
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');
    // A rede falhou; o som é a única coisa que ainda pode chamar ajuda.
    expect(stopLocalAlarm).not.toHaveBeenCalled();
  });

  it('silencia o alarme só quando o cuidador confirma', async () => {
    const stopLocalAlarm = vi.fn();
    const supabase = supabaseFake(async () => ({ data: alerta(), error: null }));

    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm,
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');

    c.applyServerState(alerta({ state: 'ENTREGUE' }));
    expect(stopLocalAlarm).not.toHaveBeenCalled();

    c.applyServerState(alerta({ state: 'VISUALIZADO' }));
    expect(stopLocalAlarm).not.toHaveBeenCalled();

    c.applyServerState(alerta({ state: 'CONFIRMADO', acknowledged_at: 'agora' }));
    expect(stopLocalAlarm).toHaveBeenCalledTimes(1);
    expect(c.getState()).toBe('CONFIRMADO');
  });

  it('ignora um estado do servidor que regrediria', async () => {
    const supabase = supabaseFake(async () => ({ data: alerta(), error: null }));
    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');
    c.applyServerState(alerta({ state: 'CONFIRMADO' }));
    // Evento de realtime atrasado, entregue fora de ordem.
    c.applyServerState(alerta({ state: 'ENTREGUE' }));

    expect(c.getState()).toBe('CONFIRMADO');
  });

  it('ignora evento de outro alerta', async () => {
    const supabase = supabaseFake(async () => ({ data: alerta(), error: null }));
    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm: () => {},
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');
    c.applyServerState(alerta({ id: 'outro-alerta', state: 'CONFIRMADO' }));

    expect(c.getState()).toBe('ALERTA_DISPARADO');
  });

  it('cancelar para o alarme mesmo se a rede falhar', async () => {
    const stopLocalAlarm = vi.fn();
    let primeira = true;
    const supabase = supabaseFake(async () => {
      if (primeira) {
        primeira = false;
        return { data: alerta(), error: null };
      }
      return { data: null, error: { message: 'rede caiu', status: 0 } };
    });

    const c = new EmergencyController({
      supabase,
      patientId: 'pac-1',
      startLocalAlarm: () => {},
      stopLocalAlarm,
      onStateChange: () => {},
      delay: semEspera,
    });

    await c.trigger('cli-1');
    await c.cancel();

    // Cancelar é um pedido do paciente, não uma negociação com a rede.
    expect(stopLocalAlarm).toHaveBeenCalled();
    expect(c.getState()).toBe('CANCELADO');
  });
});

describe('RPCs de emergência', () => {
  it('trigger_emergency envia o client_alert_id como chave de idempotência', async () => {
    const supabase = supabaseFake(async () => ({ data: alerta(), error: null }));
    await triggerEmergency(supabase, {
      patientId: 'pac-1',
      clientAlertId: 'cli-9',
      category: 'breath',
    });

    expect(supabase.rpc).toHaveBeenCalledWith('trigger_emergency', {
      p_patient_id: 'pac-1',
      p_client_alert_id: 'cli-9',
      p_category: 'breath',
      p_note: null,
    });
  });

  it('propaga a negativa de permissão como erro não retentável', async () => {
    const supabase = supabaseFake(async () => ({
      data: null,
      error: { code: '42501', message: 'paciente inacessivel' },
    }));

    await expect(
      triggerEmergency(supabase, { patientId: 'de-outro', clientAlertId: 'cli-1' }),
    ).rejects.toMatchObject({ code: '42501', retryable: false });
  });

  it('acknowledge devolve o alerta confirmado', async () => {
    const supabase = supabaseFake(async () => ({
      data: alerta({ state: 'CONFIRMADO', acknowledged_by: 'cuidador-1' }),
      error: null,
    }));

    const a = await acknowledgeEmergency(supabase, 'alert-1');
    expect(a.state).toBe('CONFIRMADO');
    expect(a.acknowledged_by).toBe('cuidador-1');
  });

  it('aceita a linha vinda como array de um elemento', async () => {
    const supabase = supabaseFake(async () => ({ data: [alerta()], error: null }));
    const a = await triggerEmergency(supabase, { patientId: 'p', clientAlertId: 'c' });
    expect(a.id).toBe('alert-1');
  });
});
