// Dependências compartilhadas das Edge Functions (Deno).
// Versões fixadas: uma Edge Function que resolve "latest" muda de
// comportamento sozinha, e a de emergência não pode fazer isso.

export { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';
export type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Cliente com service role. Só para o que a RLS legitimamente impede. */
export function adminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Cliente no contexto do usuário chamador.
 *
 * Usado sempre que a operação PODE respeitar a RLS — o service role é a
 * exceção justificada, não o padrão. Uma função que usa service role para
 * tudo transforma a RLS em decoração.
 */
export function userClient(req: Request) {
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const auth = req.headers.get('Authorization');
  if (!url || !anon) throw new Error('SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórias');
  if (!auth) return null;
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });
}

/** SHA-256 em hexadecimal — mesmo formato que `encode(digest(...),'hex')` no Postgres. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
