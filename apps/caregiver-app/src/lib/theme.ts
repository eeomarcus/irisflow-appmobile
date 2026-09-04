/**
 * Tokens visuais.
 *
 * A paleta segue o azul institucional da IrisFlow (#1B54A8, o mesmo do
 * Blinkv1). Cor de urgência é usada com parcimônia: o §5 pede comportamento
 * visual distinto por nível e, na mesma frase, avisa contra excesso de cores
 * e animação. Aqui só `urgente` e `emergencia` ganham cor própria; `normal`
 * e `importante` se diferenciam por peso e posição, não por tinta.
 */

import type { UrgencyLevel } from '@irisflow/comm-client';

export const cores = {
  fundo: '#F7F9FC',
  cartao: '#FFFFFF',
  borda: '#E2E8F0',
  texto: '#0F172A',
  textoFraco: '#64748B',
  primaria: '#1B54A8',
  primariaFraca: '#EFF4FC',
  online: '#059669',
  offline: '#94A3B8',
  urgente: '#D97706',
  emergencia: '#DC2626',
  emergenciaFundo: '#FEF2F2',
  sucesso: '#059669',
  erro: '#DC2626',
} as const;

export const espaco = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const raio = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

/**
 * Altura mínima de alvo tocável.
 *
 * 48 dp é o mínimo do Material Design e do WCAG 2.2 (2.5.8). Aqui não é
 * negociável nem em botão secundário: o cuidador costuma usar este app
 * andando pela casa, às pressas, muitas vezes de madrugade e sem óculos.
 */
export const ALVO_MIN = 48;

export interface EstiloUrgencia {
  cor: string;
  fundo: string;
  rotulo: string;
  peso: '600' | '700' | '800';
}

export function estiloDaUrgencia(u: UrgencyLevel): EstiloUrgencia {
  switch (u) {
    case 'emergencia':
      return { cor: cores.emergencia, fundo: cores.emergenciaFundo, rotulo: 'EMERGÊNCIA', peso: '800' };
    case 'urgente':
      return { cor: cores.urgente, fundo: '#FFFBEB', rotulo: 'Urgente', peso: '700' };
    case 'importante':
      return { cor: cores.texto, fundo: cores.cartao, rotulo: 'Importante', peso: '600' };
    default:
      return { cor: cores.texto, fundo: cores.cartao, rotulo: '', peso: '600' };
  }
}

/**
 * Horário legível.
 *
 * "há 3 min" em vez de "14:07" para o passado recente: numa conversa de
 * cuidado, a distância no tempo é a informação, não o instante. Acima de um
 * dia o inverso passa a valer, e a data volta a ser mais útil.
 */
export function horaRelativa(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);

  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;

  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;

  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function horaCurta(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
