/**
 * Destino: `frontend/src/pages/caregiver/TalkToCaregiverScreen.tsx`
 *
 * Arquivo NOVO. A tela "Falar com cuidador" do §9.
 *
 * Duas decisões estruturais:
 *
 * 1. Usa `GazeGrid`, `GazeButton` e `GazePageLayout` que já existem, sem
 *    criar componente novo. Não é economia: é o único jeito de a tela
 *    herdar automaticamente o dwell, o `alvoMinimoPx()` e o comportamento em
 *    rastreamento degradado que o paciente já configurou. Uma grade própria
 *    ficaria de fora dessas regras no dia em que elas mudassem.
 *
 * 2. Seis alvos, dois por linha, na ordem exata de prioridade do briefing:
 *    Emergência, Pedir ajuda, SIM, NÃO, Frases, Histórico. A tela não tem
 *    scroll, não tem submenu e não tem texto longo (§21).
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertOctagon, Check, History, LifeBuoy, MessageSquare, X,
} from 'lucide-react';
import { QUICK_PHRASES, urgencyOf } from '@irisflow/comm-client';
import { GazePageLayout } from '../../components/ui/GazePageLayout';
import { GazeButton } from '../../components/ui/GazeButton';
import { GazeGrid } from '../../components/ui/GazeGrid';
import { useComm } from '../../context/CommContext';
import { useEmergency } from '../../context/EmergencyContext';

type Modo = 'principal' | 'frases';

export const TalkToCaregiverScreen: React.FC = () => {
  const navigate = useNavigate();
  const { enabled, send, outbox, connection } = useComm();
  const { triggerEmergencyImmediately } = useEmergency();
  const [modo, setModo] = useState<Modo>('principal');
  const [ultimo, setUltimo] = useState<string | null>(null);

  /**
   * Confirmação visível por 4 s.
   *
   * O retorno vem do outbox, não de um otimismo local: enquanto o servidor
   * não confirma, a frase é "Enviando…". Nunca "Enviado" (§13).
   */
  const enviar = async (texto: string, phraseId?: string) => {
    const id = await send(
      texto,
      phraseId === 'yes' ? 'yes' : phraseId === 'no' ? 'no' : 'quick_phrase',
      phraseId ? urgencyOf(phraseId) : 'normal',
    );
    setUltimo(id);
    setModo('principal');
    setTimeout(() => setUltimo((atual) => (atual === id ? null : atual)), 4000);
  };

  const estadoDoUltimo = ultimo ? outbox.find((o) => o.clientId === ultimo)?.state : null;

  if (!enabled) {
    return (
      <GazePageLayout showBack backRoute="/menu">
        <div style={est.centro}>
          <h1 style={est.titulo}>Falar com cuidador</h1>
          <p style={est.aviso}>
            Este computador ainda não está vinculado a um cuidador.
            <br />
            Peça a quem cuida de você para fazer a configuração.
          </p>
        </div>
      </GazePageLayout>
    );
  }

  return (
    <GazePageLayout showBack backRoute="/menu">
      <div style={est.tela}>
        <header style={est.cabecalho}>
          <h1 style={est.titulo}>
            {modo === 'frases' ? 'O que você quer dizer?' : 'Falar com cuidador'}
          </h1>

          {/* Estado do envio. É a peça que impede a tela de mentir. */}
          {estadoDoUltimo && (
            <p
              role="status"
              aria-live="polite"
              style={{
                ...est.retorno,
                color:
                  estadoDoUltimo === 'sent' ? '#059669'
                  : estadoDoUltimo === 'failed' ? '#dc2626'
                  : '#64748b',
              }}
            >
              {estadoDoUltimo === 'sent' && '✓ Enviado ao seu cuidador'}
              {(estadoDoUltimo === 'queued' || estadoDoUltimo === 'sending') && 'Enviando…'}
              {estadoDoUltimo === 'failed' && '✕ Não consegui enviar. Vou tentar de novo.'}
            </p>
          )}

          {!estadoDoUltimo && connection !== 'connected' && (
            <p style={est.retorno}>
              Sem conexão no momento. Suas mensagens serão enviadas quando voltar.
            </p>
          )}
        </header>

        <div style={est.corpo}>
          {modo === 'principal' ? (
            <GazeGrid columns={2} rows={3}>
              {/* Prioridade 1 — a única com dwell longo e cor própria. */}
              <GazeButton
                emergency
                data-dwell-ms={2400}
                onClick={triggerEmergencyImmediately}
                style={{ ...est.alvo, ...est.alvoEmergencia }}
                aria-label="Emergência"
              >
                <AlertOctagon size={64} color="#fff" />
                <span style={est.rotuloBranco}>EMERGÊNCIA</span>
              </GazeButton>

              {/* Prioridade 2 */}
              <GazeButton
                onClick={() => void enviar('Preciso de ajuda.', 'help')}
                style={{ ...est.alvo, ...est.alvoAjuda }}
                aria-label="Pedir ajuda"
              >
                <LifeBuoy size={60} color="#b45309" />
                <span style={{ ...est.rotulo, color: '#b45309' }}>PEDIR AJUDA</span>
              </GazeButton>

              {/* Prioridades 3 e 4 — o par mais usado numa conversa por olhar. */}
              <GazeButton
                onClick={() => void enviar('Sim.', 'yes')}
                style={{ ...est.alvo, ...est.alvoSim }}
                aria-label="Sim"
              >
                <Check size={64} color="#047857" />
                <span style={{ ...est.rotulo, color: '#047857' }}>SIM</span>
              </GazeButton>

              <GazeButton
                onClick={() => void enviar('Não.', 'no')}
                style={{ ...est.alvo, ...est.alvoNao }}
                aria-label="Não"
              >
                <X size={64} color="#334155" />
                <span style={{ ...est.rotulo, color: '#334155' }}>NÃO</span>
              </GazeButton>

              {/* Prioridades 5 e 6 */}
              <GazeButton
                onClick={() => setModo('frases')}
                style={est.alvo}
                aria-label="Frases rápidas"
              >
                <MessageSquare size={56} color="#1B54A8" />
                <span style={{ ...est.rotulo, color: '#1B54A8' }}>FRASES</span>
              </GazeButton>

              <GazeButton
                onClick={() => navigate('/caregiver-chat/history')}
                style={est.alvo}
                aria-label="Histórico de mensagens"
              >
                <History size={56} color="#1B54A8" />
                <span style={{ ...est.rotulo, color: '#1B54A8' }}>HISTÓRICO</span>
              </GazeButton>
            </GazeGrid>
          ) : (
            /* Frases sem os quatro atalhos que já estão na tela anterior:
               repeti-los aqui seria oferecer dois caminhos para a mesma coisa
               numa interface que precisa ter o menor número possível deles. */
            <GazeGrid columns={3} rows={3}>
              {QUICK_PHRASES
                .filter((p) => !['yes', 'no', 'help', 'come_here'].includes(p.id))
                .slice(0, 8)
                .map((p) => (
                  <GazeButton
                    key={p.id}
                    onClick={() => void enviar(p.text, p.id)}
                    style={est.alvoFrase}
                    aria-label={p.text}
                  >
                    <span style={est.textoFrase}>{p.text}</span>
                  </GazeButton>
                ))}

              <GazeButton
                onClick={() => setModo('principal')}
                style={{ ...est.alvoFrase, background: '#e2e8f0' }}
                aria-label="Voltar"
              >
                <span style={{ ...est.textoFrase, color: '#334155' }}>‹ VOLTAR</span>
              </GazeButton>
            </GazeGrid>
          )}
        </div>
      </div>
    </GazePageLayout>
  );
};

const est: Record<string, React.CSSProperties> = {
  tela: { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' },
  cabecalho: { textAlign: 'center', marginBottom: '1.5rem', minHeight: '5.5rem' },
  titulo: { fontSize: '2.5rem', fontWeight: 800, margin: 0, color: 'var(--color-text-base)' },
  retorno: { fontSize: '1.35rem', fontWeight: 700, margin: '0.5rem 0 0 0' },
  corpo: { flex: 1, minHeight: 0 },
  centro: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', textAlign: 'center',
  },
  aviso: { fontSize: '1.5rem', lineHeight: 2, color: 'var(--color-text-base)', opacity: 0.75 },

  alvo: {
    height: '100%', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '0.75rem',
    background: '#fff', border: '3px solid #cbd5e1', borderRadius: '1.75rem',
  },
  alvoEmergencia: { background: '#dc2626', border: '4px solid #991b1b' },
  alvoAjuda: { background: '#fef3c7', border: '3px solid #f59e0b' },
  alvoSim: { background: '#d1fae5', border: '3px solid #10b981' },
  alvoNao: { background: '#f1f5f9', border: '3px solid #94a3b8' },
  rotulo: { fontSize: '1.9rem', fontWeight: 900, letterSpacing: '0.5px' },
  rotuloBranco: { fontSize: '1.9rem', fontWeight: 900, color: '#fff', letterSpacing: '0.5px' },

  alvoFrase: {
    height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#fff', border: '3px solid #cbd5e1', borderRadius: '1.5rem',
    padding: '1rem',
  },
  textoFrase: {
    fontSize: '1.5rem', fontWeight: 800, textAlign: 'center',
    color: 'var(--color-text-base)', lineHeight: 1.3,
  },
};
