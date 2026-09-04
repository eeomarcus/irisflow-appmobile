# Contratos de API

Superfície completa do canal de comunicação. Três camadas:

| Camada | Quando |
|---|---|
| **RPC** (`supabase.rpc`) | toda **escrita** |
| **Tabela/view** (`supabase.from`) | toda **leitura**, filtrada por RLS |
| **Edge Function** | quando a operação precisa de privilégio que a RLS legitimamente nega |

Regra que atravessa tudo: **o cliente nunca informa quem ele é.**
`patient_id`, `caregiver_id` e `sender_id` são derivados de `auth.uid()` ou da
conversa. Não existe parâmetro de identidade em nenhuma escrita — é o que
elimina, por construção, o "alteração de patient_id / caregiver_id" do §23.

Erros usam SQLSTATE:

| Código | Significado | Retentar? |
|---|---|---|
| `28000` | não autenticado | não |
| `42501` | sem permissão (sem vínculo, vínculo revogado, recurso de outro paciente) | não |
| `22023` | transição de estado inválida | não |
| `23514` | corpo vazio ou acima de 2000 caracteres | não |
| `54000` | limite de mensagens por minuto | sim, com backoff |

`42501` é a mesma resposta para "não existe" e "não é seu". A indistinção é
deliberada: separar os dois transformaria cada endpoint num verificador de
existência de pacientes e conversas.

---

## Autenticação

Supabase Auth (GoTrue), a mesma conta do site. Sem sistema novo (§7).

```ts
supabase.auth.signInWithPassword({ email, password })
supabase.auth.getSession()
supabase.auth.onAuthStateChange(cb)
supabase.auth.resetPasswordForEmail(email)
supabase.auth.signOut()
```

Sessão persistida via `StorageAdapter` injetado: `expo-secure-store` no
celular, `localStorage` no Electron. Refresh automático pelo SDK.

---

## Mensagens

### `send_message`

```ts
supabase.rpc('send_message', {
  p_conversation_id:   uuid,
  p_client_message_id: uuid,        // gerado NO CLIENTE, antes do envio
  p_body:              string,      // 1..2000
  p_kind:              'text' | 'quick_phrase' | 'yes' | 'no' | 'request' | 'system',
  p_urgency:           'normal' | 'importante' | 'urgente' | 'emergencia',
}) // -> messages
```

**Idempotente** por `(conversation_id, client_message_id)`. Reenviar devolve a
linha existente com o mesmo `id`, e isso é sucesso, não erro.

Por que isso não é um detalhe: um *timeout* não significa que a mensagem não
chegou — significa que a resposta não voltou. Sem a chave de idempotência, a
retentativa correta produziria duplicata, e "Preciso de ajuda" apareceria três
vezes para o cuidador, como se fossem três pedidos.

O mesmo mecanismo bloqueia replay: reenviar uma requisição capturada não cria
uma segunda mensagem.

Rate limit: 60/min por remetente e conversa. **`emergencia` é isenta** —
limitar o canal que socorre a pessoa para conter spam seria a troca errada.

### `broadcast_patient_message`

```ts
supabase.rpc('broadcast_patient_message', {
  p_patient_id:        uuid,
  p_client_message_id: uuid,        // o MESMO em todas as conversas
  p_body:              string,
  p_kind, p_urgency,
}) // -> messages[]
```

Uma escolha do paciente vira uma mensagem em cada conversa ativa. A unique é
por conversa, então o id repetido não colide e cada fio segue idempotente na
retentativa. Perguntar "para qual cuidador?" seria uma decisão a mais numa
tela que o §21 manda enxugar.

### Recibos

```ts
supabase.rpc('mark_messages_delivered', { p_message_ids: uuid[] }) // -> integer
supabase.rpc('mark_messages_read',      { p_message_ids: uuid[] }) // -> integer
```

Sempre para `auth.uid()`. Não há parâmetro de destinatário: deixar o cliente
escolher permitiria marcar como lida uma mensagem que outra pessoa nunca viu,
e o paciente veria "✓✓ lida" sem que ninguém tivesse lido.

`mark_messages_read` também preenche `delivered_at` quando está nulo — lida
implica entregue, mesmo que o push tenha falhado e o cuidador tenha aberto o
app por conta própria.

### Leitura

```ts
supabase.from('messages').select('*')
  .eq('conversation_id', id)
  .is('deleted_at', null)
  .order('created_at', { ascending: false })
  .limit(50)
  .lt('created_at', cursor)        // paginação

supabase.from('v_caregiver_conversations').select('*')   // tela inicial
supabase.from('v_message_status').select('*').in('message_id', ids)
```

---

## Emergência

```ts
supabase.rpc('trigger_emergency', {
  p_patient_id:      uuid,
  p_client_alert_id: uuid,
  p_category:        'pain' | 'breath' | 'cold' | 'other',
  p_note:            string | null,
}) // -> emergency_alerts

supabase.rpc('mark_emergency_delivered', { p_alert_id })  // app do cuidador
supabase.rpc('mark_emergency_seen',      { p_alert_id })  // alerta aberto
supabase.rpc('acknowledge_emergency',    { p_alert_id })  // "RECEBI, ESTOU INDO"
supabase.rpc('cancel_emergency',         { p_alert_id })  // só o paciente
supabase.rpc('fail_emergency',           { p_alert_id, p_reason })
```

`trigger_emergency` tem **duas** proteções contra disparo repetido, com
propósitos diferentes:

1. `client_alert_id` — cobre a retentativa do outbox.
2. Janela de 30 s — cobre o reacionamento pelo olhar e o abuso do endpoint.
   Devolve o alerta **ativo** em vez de criar outro.

Nenhuma das duas rejeita a chamada. Recusar um disparo de emergência para
conter abuso seria a troca errada; o certo é convergir para um alerta só.

`mark_emergency_delivered` é chamada **pelo app do cuidador**, nunca pelo
serviço de push. Um ticket aceito pelo Expo diz que o Expo aceitou, não que o
celular acordou (§25.19).

`cancel_emergency` só aceita o paciente ou quem administra o cadastro. Um
cuidador vinculado não cancela: só quem disparou pode dizer que não era nada.

Cada transição grava em `emergency_alert_events` (append-only, com autor e
horário) — a única fonte capaz de responder "quando o cuidador soube?".

---

## Vínculo

```ts
supabase.rpc('create_link_invite', { p_patient_id, p_role })
// -> { code: string, expires_at: timestamptz }
```

Devolve o código em texto claro **uma única vez**. O banco guarda só o
SHA-256; não existe caminho para lê-lo de novo. Perdeu, gera outro.

Alfabeto sem `0/O` e `1/I/L` — o código costuma ser ditado por telefone, e
"zero ou ó" é falha de usabilidade que vira chamado de suporte.

```http
POST /functions/v1/link-accept
Authorization: Bearer <jwt do cuidador>
{ "code": "ABCD2345" }

200 { ok: true, link_id, patient_id, patient_name, conversation_id, role }
400 { ok: false, error: "codigo_invalido",
      message: "Código inválido, expirado ou já utilizado." }
```

Edge Function e não RPC: validar o código exige ler `care_link_invites`, e a
RLS dessa tabela — corretamente — só libera para quem administra o paciente.
O cuidador que está aceitando é, por definição, quem ainda não pode ler. O
service role fica isolado em um arquivo, com uma entrada.

**Contra enumeração e força bruta:** resposta idêntica para inválido/expirado/
usado; atraso constante de 400 ms em toda negativa (para o tempo não virar
oráculo); uso único garantido por `update ... where used_at is null` **antes**
de criar o vínculo; 31^8 ≈ 8,5×10^11 combinações contra uma janela de 24 h.

```ts
supabase.rpc('revoke_link', { p_link_id })   // status revoked, nunca delete
```

Revogação corta o acesso no próximo `select` — `has_patient_access` exige
`status = 'active'`. Não espera sessão expirar.

---

## Presença e push

```ts
supabase.rpc('touch_presence', { p_patient_id, p_irisflow_running })  // 60 s
supabase.rpc('register_push_token', { p_token, p_platform, p_device, p_critical_ok })
supabase.from('care_patient_presence').select('*').eq('patient_id', id)
```

Presença é grosseira de propósito: `online`/`offline`/`unknown`,
`last_seen_at`, `irisflow_running`. Nada responde "o que o paciente está
fazendo" (§11).

`register_push_token` migra o token de dono quando outra pessoa entra no mesmo
aparelho — sem isso, o cuidador anterior continuaria recebendo os alertas.

---

## Tempo real

```ts
supabase.channel(`conversation:${id}`)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages',
      filter: `conversation_id=eq.${id}` }, onMessage)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_alerts',
      filter: `patient_id=eq.${patientId}` }, onAlert)
  .subscribe()
```

Tabelas publicadas: `messages`, `message_receipts`, `emergency_alerts`,
`care_patient_presence`.

O `filter` é banda, **não** segurança — o Realtime respeita RLS, e uma
inscrição na conversa alheia não devolveria linha alguma.

**Toda subscrição bem-sucedida dispara um catch-up.** `SUBSCRIBED` não
significa "não perdi nada": o SDK reconecta em silêncio, e o intervalo em que
esteve fora viraria um buraco invisível no histórico. Num app de conversa isso
é um incômodo; aqui a mensagem perdida pode ser "Preciso de ajuda".

---

## Webhooks (configurados no painel)

| Tabela | Evento | Destino |
|---|---|---|
| `messages` | INSERT | `push-fanout` |
| `emergency_alerts` | INSERT | `push-fanout` |

Header `x-webhook-secret` obrigatório — o webhook do Supabase não assina o
corpo, e sem o segredo qualquer um chamaria a função para disparar push
arbitrário nos aparelhos dos cuidadores.

## Cron

| Frequência | Função |
|---|---|
| 1 min | `emergency-dispatch` (escalonamento) |
| 5 min | `expire_stale_presence()` |
| diário | `purge_old_messages(12)` |

`purge_old_messages` e `expire_stale_presence` têm `execute` revogado de
`authenticated`: dar ao app um botão de apagar histórico não é uma
funcionalidade, é uma vulnerabilidade.
