/**
 * Destino: `frontend/src/pages/output/EmergencyStatusPanel.tsx`
 *
 * Arquivo NOVO, para ser usado DENTRO de `EmergencyEscalation.tsx`.
 *
 * ── O defeito que este componente conserta ────────────────────────────────
 *
 * O código atual do Blinkv1 faz, em `EmergencyEscalation.tsx`:
 *
 *     api.sendHelpAlert(...).catch((e) => { console.warn(...) });
 *
 * e a tela exibe, incondicionalmente:
 *
 *     "Seu alerta foi enviado. Aguarde atendimento."
 *
 * O `catch` engole a falha. Como `env.apiUrl` aponta para um
 * `http://localhost:8000/api` que não existe em lugar nenhum do repositório,
 * essa promessa hoje é falsa em 100% dos casos.
 *
 * Para uma pessoa com ELA sozinha em casa, a diferença entre "o socorro foi
 * chamado" e "ninguém foi avisado, grite se puder" é a diferença que o
 * produto inteiro existe para cobrir. O §13 do briefing diz isso em uma
 * linha: *nunca mostrar "enviado" se o servidor não confirmou.*
 *
 * ── O que este painel faz ─────────────────────────────────────────────────
 *
 * Exibe o estado REAL do alerta, vindo de `describeState()` — a mesma fonte
 * que decide se o alarme sonoro continua tocando. Uma fonte só para as duas
 * coisas evita a divergência clássica entre o que a tela diz e o que o som faz.
 */

import React from 'react';
import { AlertOctagon, CheckCircle2, Loader2, WifiOff } from 'lucide-react';
import { describeState, type EmergencyState } from '@irisflow/comm-client';

interface Props {
  state: EmergencyState;
  /** Horário do acionamento, para o paciente saber há quanto tempo espera. */
  triggeredAt?: string | null;
}

export const EmergencyStatusPanel: React.FC<Props> = ({ state, triggeredAt }) => {
  const d = describeState(state);

  const cor =
    d.tone === 'good' ? '#059669'
    : d.tone === 'bad' ? '#b91c1c'
    : '#dc2626';

  const Icone =
    d.tone === 'good' ? CheckCircle2
    : d.tone === 'bad' ? WifiOff
    : state === 'ENVIANDO' ? Loader2
    : AlertOctagon;

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '2rem',
        border: `4px solid ${cor}`,
        background: d.tone === 'good' ? 'rgba(5,150,105,0.06)' : 'rgba(220,38,38,0.06)',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <Icone
        size={104}
        color={cor}
        aria-hidden="true"
        style={state === 'ENVIANDO' ? { animation: 'irisSpin 1.2s linear infinite' } : undefined}
      />

      <h2 style={{ fontSize: '2.9rem', color: cor, fontWeight: 800, margin: '1.5rem 0 0 0' }}>
        {d.title}
      </h2>

      <p style={{ fontSize: '1.7rem', color: '#334155', fontWeight: 600, marginTop: '0.75rem' }}>
        {d.detail}
      </p>

      {triggeredAt && (
        <p style={{ fontSize: '1.15rem', color: '#64748b', marginTop: '1rem' }}>
          Acionado às{' '}
          {new Date(triggeredAt).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}

      {/*
       * Só aparece quando o alarme continua tocando. É a informação que
       * substitui a falsa garantia: o paciente precisa saber que ainda
       * depende de alguém ouvir o som, e não presumir que a ajuda está
       * a caminho.
       */}
      {d.keepAlarm && (
        <p
          style={{
            fontSize: '1.15rem',
            color: '#7c2d12',
            background: '#fef3c7',
            borderRadius: '1rem',
            padding: '0.85rem 1.4rem',
            marginTop: '1.5rem',
            fontWeight: 700,
          }}
        >
          🔊 O alarme sonoro está tocando neste computador.
        </p>
      )}

      <style>{`
        @keyframes irisSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};
