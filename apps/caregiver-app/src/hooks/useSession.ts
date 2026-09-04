/**
 * Sessão do cuidador.
 *
 * Fina de propósito: quem faz o trabalho de verdade é o Supabase Auth. O
 * §7 do briefing manda reutilizar a autenticação existente em vez de criar
 * outra, e a conta aqui é a mesma do site (`profiles` -> `auth.users`).
 */

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { comm } from '../lib/supabase';

export interface EstadoSessao {
  session: Session | null;
  carregando: boolean;
  configurado: boolean;
}

export function useSession(): EstadoSessao {
  const [session, setSession] = useState<Session | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    if (!comm) {
      setCarregando(false);
      return;
    }

    let vivo = true;

    comm.supabase.auth.getSession().then(({ data }) => {
      if (!vivo) return;
      setSession(data.session);
      setCarregando(false);
    });

    // Cobre refresh de token, expiração e logout em outro dispositivo. Sem
    // isto, a UI continuaria mostrando conversas cujas consultas já estariam
    // voltando vazias por RLS — um estado enganoso justamente na tela que
    // precisa ser confiável.
    const { data: sub } = comm.supabase.auth.onAuthStateChange((_evento, s) => {
      if (vivo) setSession(s);
    });

    return () => {
      vivo = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, carregando, configurado: comm !== null };
}

export async function entrar(email: string, senha: string): Promise<string | null> {
  if (!comm) return 'App não configurado.';
  const { error } = await comm.supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: senha,
  });
  return error ? traduzir(error.message) : null;
}

export async function sair(): Promise<void> {
  await comm?.supabase.auth.signOut();
}

export async function recuperarAcesso(email: string): Promise<string | null> {
  if (!comm) return 'App não configurado.';
  const { error } = await comm.supabase.auth.resetPasswordForEmail(
    email.trim().toLowerCase(),
  );
  return error ? traduzir(error.message) : null;
}

/**
 * Mensagens em português.
 *
 * "Invalid login credentials" é deliberadamente ambíguo do lado do Supabase
 * — não diz se o e-mail existe. A tradução preserva essa ambiguidade em vez
 * de "esclarecer", porque esclarecer aqui é entregar um oráculo de
 * enumeração de usuários (§23).
 */
function traduzir(msg: string): string {
  const mapa: Record<string, string> = {
    'Invalid login credentials': 'E-mail ou senha incorretos.',
    'Email not confirmed': 'Confirme seu e-mail antes de entrar.',
    'Network request failed': 'Sem conexão. Verifique sua internet.',
    'For security purposes, you can only request this after 60 seconds.':
      'Aguarde um minuto antes de tentar de novo.',
  };
  return mapa[msg] ?? msg;
}
