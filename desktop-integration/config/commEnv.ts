/**
 * Destino: `frontend/src/config/commEnv.ts`
 *
 * Arquivo NOVO. Não altera `config/env.ts`, que continua servindo à voz e ao
 * chatbot.
 *
 * A ausência de configuração é um estado de primeira classe. Sem
 * `VITE_SUPABASE_URL`, `commEnv.enabled` é `false` e a funcionalidade some
 * da interface — o menu não ganha o item, a tela não é alcançável, nenhuma
 * chamada de rede sai. O IrisFlow se comporta exatamente como hoje.
 *
 * O contrário — deixar a tela visível e falhar ao usá-la — é o defeito que
 * já existe em `utils/api.ts`, que aponta para um `localhost:8000` inexistente
 * e engole o erro. Uma funcionalidade meio ligada é pior que uma desligada,
 * porque cria a expectativa de que alguém está ouvindo do outro lado.
 */

export const commEnv = {
  supabaseUrl: (import.meta.env.VITE_SUPABASE_URL ?? '').trim(),
  supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim(),

  /**
   * Id do paciente que este computador representa.
   *
   * Gravado pela tela de pareamento na primeira configuração; a variável de
   * ambiente é só o atalho para uma instalação pré-configurada pela equipe.
   */
  patientId: (import.meta.env.VITE_IRISFLOW_PATIENT_ID ?? '').trim(),
} as const;

export const commEnabled =
  commEnv.supabaseUrl.length > 0 && commEnv.supabaseAnonKey.length > 0;
