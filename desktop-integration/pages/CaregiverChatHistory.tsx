/**
 * Destino: `frontend/src/pages/caregiver/CaregiverChatHistory.tsx`
 *
 * Arquivo NOVO. Histórico da conversa, lido pelo paciente.
 *
 * Uma tela de leitura operada por olhar tem uma restrição que uma tela de
 * conversa comum não tem: rolagem contínua é ruim de controlar por fixação.
 * Por isso o histórico é PAGINADO em blocos de quatro mensagens, com dois
 * alvos grandes de navegação — nada de scroll por olhar.
 *
 * Mostra as últimas mensagens em ordem inversa (a mais recente primeiro),
 * porque quem abre o histórico quase sempre quer saber o que o cuidador
 * acabou de responder.
 */

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { GazePageLayout } from '../../components/ui/GazePageLayout';
import { GazeButton } from '../../components/ui/GazeButton';
import { useComm } from '../../context/CommContext';

const POR_PAGINA = 4;

export const CaregiverChatHistory: React.FC = () => {
  const { messages } = useComm();
  const [pagina, setPagina] = useState(0);

  const recentes = [...messages].reverse();
  const total = Math.max(1, Math.ceil(recentes.length / POR_PAGINA));
  const bloco = recentes.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);

  return (
    <GazePageLayout showBack backRoute="/caregiver-chat">
      <div style={est.tela}>
        <h1 style={est.titulo}>Suas mensagens</h1>

        {recentes.length === 0 ? (
          <div style={est.vazio}>
            <p style={est.vazioTexto}>Nenhuma mensagem ainda.</p>
          </div>
        ) : (
          <>
            <div style={est.lista}>
              {bloco.map((m) => {
                const doPaciente = m.sender_kind === 'patient';
                return (
                  <div
                    key={m.id}
                    style={{
                      ...est.item,
                      background: doPaciente ? '#EFF4FC' : '#F0FDF4',
                      borderLeft: `8px solid ${doPaciente ? '#1B54A8' : '#059669'}`,
                    }}
                  >
                    <div style={est.itemTopo}>
                      <span style={{ ...est.autor, color: doPaciente ? '#1B54A8' : '#047857' }}>
                        {doPaciente ? 'Você disse' : 'Seu cuidador disse'}
                      </span>
                      <span style={est.hora}>
                        {new Date(m.created_at).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p style={est.corpo}>{m.body}</p>
                  </div>
                );
              })}
            </div>

            <div style={est.navegacao}>
              <GazeButton
                onClick={() => setPagina((p) => Math.max(0, p - 1))}
                disabled={pagina === 0}
                style={{ ...est.navBotao, opacity: pagina === 0 ? 0.35 : 1 }}
                aria-label="Mensagens mais recentes"
              >
                <ChevronLeft size={44} />
                <span style={est.navTexto}>MAIS NOVAS</span>
              </GazeButton>

              <span style={est.contador}>
                {pagina + 1} / {total}
              </span>

              <GazeButton
                onClick={() => setPagina((p) => Math.min(total - 1, p + 1))}
                disabled={pagina >= total - 1}
                style={{ ...est.navBotao, opacity: pagina >= total - 1 ? 0.35 : 1 }}
                aria-label="Mensagens mais antigas"
              >
                <span style={est.navTexto}>MAIS ANTIGAS</span>
                <ChevronRight size={44} />
              </GazeButton>
            </div>
          </>
        )}
      </div>
    </GazePageLayout>
  );
};

const est: Record<string, React.CSSProperties> = {
  tela: { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' },
  titulo: {
    fontSize: '2.4rem', fontWeight: 800, textAlign: 'center',
    margin: '0 0 1.5rem 0', color: 'var(--color-text-base)',
  },
  lista: { flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: 0 },
  item: { borderRadius: '1.25rem', padding: '1.25rem 1.5rem' },
  itemTopo: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  autor: { fontSize: '1.1rem', fontWeight: 800, textTransform: 'uppercase' },
  hora: { fontSize: '1.05rem', color: '#64748b' },
  corpo: { fontSize: '1.6rem', fontWeight: 600, margin: '0.4rem 0 0 0', lineHeight: 1.4 },
  navegacao: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '1.5rem', marginTop: '1.5rem',
  },
  navBotao: {
    flex: 1, height: '96px', display: 'flex', alignItems: 'center',
    justifyContent: 'center', gap: '0.75rem', background: '#fff',
    border: '3px solid #cbd5e1', borderRadius: '1.5rem', color: '#1B54A8',
  },
  navTexto: { fontSize: '1.3rem', fontWeight: 800 },
  contador: { fontSize: '1.4rem', fontWeight: 700, color: '#64748b', minWidth: '5rem', textAlign: 'center' },
  vazio: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  vazioTexto: { fontSize: '1.7rem', color: '#64748b' },
};
