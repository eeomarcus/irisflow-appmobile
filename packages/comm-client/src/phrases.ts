/**
 * Frases rápidas e o nível de urgência de cada uma.
 *
 * Ficam aqui, e não em cada app, por um motivo prático: a urgência define o
 * canal de notificação (§8). Se o desktop dissesse que "Estou com dor" é
 * `normal` e o app do cuidador o tratasse como `urgente`, o mesmo texto
 * chegaria com prioridades diferentes dependendo do caminho — e ninguém
 * conseguiria explicar por quê.
 *
 * A classificação segue os exemplos do §5 do briefing. Note que "Estou com
 * dor" é `urgente` e não `importante`: dor em quem não consegue se mexer
 * nem mudar de posição sozinho não espera a próxima ronda.
 */

import type { MessageKind, UrgencyLevel } from './types';

export interface QuickPhrase {
  id: string;
  text: string;
  urgency: UrgencyLevel;
  kind: MessageKind;
  /** Nome do ícone em lucide-react / lucide-react-native. */
  icon: string;
}

/** Frases do paciente. Ordem = ordem de exibição na grade de olhar. */
export const QUICK_PHRASES: readonly QuickPhrase[] = [
  // --- as duas primeiras são as do §9: ajuda antes de qualquer outra coisa
  { id: 'help',      text: 'Preciso de ajuda.',        urgency: 'urgente',    kind: 'request',      icon: 'LifeBuoy' },
  { id: 'come_here', text: 'Venha aqui, por favor.',   urgency: 'urgente',    kind: 'request',      icon: 'Hand' },

  // --- sim / não: o par mais usado numa conversa por olhar
  { id: 'yes',       text: 'Sim.',                     urgency: 'normal',     kind: 'yes',          icon: 'Check' },
  { id: 'no',        text: 'Não.',                     urgency: 'normal',     kind: 'no',           icon: 'X' },

  // --- necessidades do cotidiano
  { id: 'thirsty',   text: 'Estou com sede.',          urgency: 'importante', kind: 'quick_phrase', icon: 'CupSoda' },
  { id: 'hungry',    text: 'Estou com fome.',          urgency: 'importante', kind: 'quick_phrase', icon: 'Utensils' },
  { id: 'bathroom',  text: 'Preciso ir ao banheiro.',  urgency: 'importante', kind: 'quick_phrase', icon: 'DoorOpen' },
  { id: 'position',  text: 'Quero mudar de posição.',  urgency: 'importante', kind: 'quick_phrase', icon: 'Move' },

  // --- desconforto
  { id: 'pain',      text: 'Estou com dor.',           urgency: 'urgente',    kind: 'quick_phrase', icon: 'HeartPulse' },
  { id: 'cold',      text: 'Estou com frio.',          urgency: 'importante', kind: 'quick_phrase', icon: 'Snowflake' },
  { id: 'hot',       text: 'Estou com calor.',         urgency: 'importante', kind: 'quick_phrase', icon: 'Thermometer' },
  { id: 'tired',     text: 'Estou cansado.',           urgency: 'normal',     kind: 'quick_phrase', icon: 'Moon' },

  // --- tranquilizar
  { id: 'ok',        text: 'Estou bem.',               urgency: 'normal',     kind: 'quick_phrase', icon: 'Smile' },
  { id: 'thanks',    text: 'Obrigado.',                urgency: 'normal',     kind: 'quick_phrase', icon: 'Heart' },
];

/**
 * Respostas rápidas do cuidador (§2).
 *
 * Todas `normal`: nada que o cuidador responda precisa acordar o paciente
 * com prioridade máxima. "Estou indo" é uma boa notícia, não um alarme.
 */
export const CAREGIVER_QUICK_REPLIES: readonly QuickPhrase[] = [
  { id: 'coming',    text: 'Estou indo aí.',            urgency: 'normal', kind: 'quick_phrase', icon: 'Footprints' },
  { id: 'one_min',   text: 'Já vou, um minuto.',        urgency: 'normal', kind: 'quick_phrase', icon: 'Clock' },
  { id: 'are_you_ok',text: 'Você está bem?',            urgency: 'normal', kind: 'quick_phrase', icon: 'HelpCircle' },
  { id: 'need_help', text: 'Você precisa de ajuda?',    urgency: 'normal', kind: 'quick_phrase', icon: 'LifeBuoy' },
  { id: 'need_smth', text: 'Precisa de alguma coisa?',  urgency: 'normal', kind: 'quick_phrase', icon: 'PackageSearch' },
  { id: 'other_room',text: 'Estou no outro quarto.',    urgency: 'normal', kind: 'quick_phrase', icon: 'Home' },
];

const POR_ID = new Map<string, QuickPhrase>(
  [...QUICK_PHRASES, ...CAREGIVER_QUICK_REPLIES].map((p) => [p.id, p]),
);

/** Urgência de uma frase conhecida. Desconhecida cai em `normal`. */
export function urgencyOf(phraseId: string): UrgencyLevel {
  return POR_ID.get(phraseId)?.urgency ?? 'normal';
}

export function findPhrase(phraseId: string): QuickPhrase | undefined {
  return POR_ID.get(phraseId);
}
