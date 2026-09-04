# Integração com o IrisFlow desktop (Blinkv1)

Passo a passo para levar `desktop-integration/` para
`Desktop/blink/Blinkv1/frontend/src/`.

Sete edições. Seis arquivos novos, cinco pontos de alteração em arquivos
existentes. **Nada em `src/tracker`, `src/l2cs`, `src/calibration`,
`src/filters`, `src/pose`, `src/preprocess`, `src/capture` ou
`GazeContext.tsx`** (§17).

---

## 0. Antes de começar

Registre a linha de base, para saber depois o que a mudança quebrou:

```bash
cd Desktop/blink/Blinkv1/frontend
npm run verify        # lint + type-check + test + build
```

---

## 1. Dependência

```bash
cd Desktop/blink/Blinkv1/frontend
npm install @supabase/supabase-js@^2.112.4
npm install "file:../../../irisflow_mobile 1.0/packages/comm-client"
```

Uma dependência de produção nova, e ela é a que o §16 previa: o mesmo SDK que
o `irisflow-site` já usa. O `comm-client` é código local, não pacote de
terceiro.

> Se o caminho relativo incomodar no CI, copie `packages/comm-client` para
> dentro do Blinkv1 como workspace. O import não muda.

---

## 2. Arquivos novos

| De `desktop-integration/` | Para `frontend/src/` |
|---|---|
| `config/commEnv.ts` | `config/commEnv.ts` |
| `context/CommContext.tsx` | `context/CommContext.tsx` |
| `utils/patientSession.ts` | `utils/patientSession.ts` |
| `pages/TalkToCaregiverScreen.tsx` | `pages/caregiver/TalkToCaregiverScreen.tsx` |
| `pages/CaregiverChatHistory.tsx` | `pages/caregiver/CaregiverChatHistory.tsx` |
| `pages/EmergencyStatusPanel.tsx` | `pages/output/EmergencyStatusPanel.tsx` |

```bash
cd "Desktop/irisflow_mobile 1.0/desktop-integration"
D=../../blink/Blinkv1/frontend/src
cp config/commEnv.ts             "$D/config/"
cp context/CommContext.tsx       "$D/context/"
cp utils/patientSession.ts       "$D/utils/"
cp pages/TalkToCaregiverScreen.tsx "$D/pages/caregiver/"
cp pages/CaregiverChatHistory.tsx  "$D/pages/caregiver/"
cp pages/EmergencyStatusPanel.tsx  "$D/pages/output/"
```

---

## 3. `.env` — e o que acontece sem ele

Crie `frontend/.env.local`:

```
VITE_SUPABASE_URL=https://ydnsnbeugxzhpkpqpqhb.supabase.co
VITE_SUPABASE_ANON_KEY=<chave anônima do painel>
```

**Sem esse arquivo, tudo abaixo continua funcionando e a funcionalidade
simplesmente não existe:** `commEnabled` fica `false`, o item some do menu, a
rota fica inalcançável, nenhuma chamada de rede sai. O IrisFlow se comporta
exatamente como hoje.

Isso é deliberado. Uma funcionalidade meio ligada é pior que uma desligada,
porque cria a expectativa de que existe alguém ouvindo do outro lado.

---

## 4. `App.tsx` — provider e duas rotas

```diff
  import { EmergencyProvider } from './context/EmergencyContext';
+ import { CommProvider } from './context/CommContext';
```

```diff
+ const TalkToCaregiverScreen = lazyNamed(
+   () => import('./pages/caregiver/TalkToCaregiverScreen'),
+   'TalkToCaregiverScreen'
+ );
+ const CaregiverChatHistory = lazyNamed(
+   () => import('./pages/caregiver/CaregiverChatHistory'),
+   'CaregiverChatHistory'
+ );
```

O provider entra **dentro** de `ReminderProvider` e **fora** de `AppRouter`?
Não: dentro do router, porque `CommContext` não usa hooks de rota, mas
`EmergencyProvider` — que vai consumi-lo — usa. A ordem que funciona:

```diff
        <ReminderProvider>
          <AppRouter>
-           <EmergencyProvider>
+           <CommProvider>
+             <EmergencyProvider>
                <DebugHUD />
                ...
-           </EmergencyProvider>
+             </EmergencyProvider>
+           </CommProvider>
          </AppRouter>
        </ReminderProvider>
```

Rotas novas, junto das de cuidador:

```diff
    <Route path="/caregiver/guide" element={<Protected><CaregiverGuide /></Protected>} />
+   <Route path="/caregiver-chat" element={<Protected><TalkToCaregiverScreen /></Protected>} />
+   <Route
+     path="/caregiver-chat/history"
+     element={<Protected><CaregiverChatHistory /></Protected>}
+   />
```

> `/caregiver-chat` e não `/caregiver/chat`: `EmergencyContext.isPatientScreen()`
> trata `path.startsWith('/caregiver')` como tela **do cuidador** e esconde o
> botão de emergência. Esta é uma tela **do paciente** — o botão precisa estar
> lá. Um hífen no lugar de uma barra evita ter que mexer naquela função.

---

## 5. `MainMenu.tsx` — um item

Em `MODULES`, logo depois de `communication`:

```diff
  {
    id: 'communication',
    ...
    route: '/phrases',
  },
+ {
+   id: 'caregiver-chat',
+   titleKey: 'menu.caregiverChat',      // "Falar com cuidador"
+   descriptionKey: 'menu.caregiverChatDesc',
+   icon: MessageSquare,                 // de lucide-react
+   route: '/caregiver-chat',
+ },
```

E as chaves em `i18n/locales/pt.json` (e nos demais idiomas):

```json
"menu.caregiverChat": "Falar com cuidador",
"menu.caregiverChatDesc": "Enviar mensagens e pedir ajuda"
```

Para esconder o item quando não há configuração, filtre a lista:

```tsx
import { commEnabled } from '../config/commEnv';
const modulos = MODULES.filter((m) => m.id !== 'caregiver-chat' || commEnabled);
```

---

## 6. `EmergencyEscalation.tsx` — a correção que importa

Hoje o arquivo faz:

```ts
api.sendHelpAlert(currentProfile?.id ?? 'anon', 'high').catch((e) => {
  console.warn('Falha ao enviar alerta de emergência ao backend:', e);
});
```

e a tela exibe, sem condição:

> *"Seu alerta foi enviado. Aguarde atendimento."*

O `catch` engole a falha, e `env.apiUrl` aponta para um `localhost:8000` que
não existe no repositório — então essa frase é falsa hoje, sempre. Substitua
o bloco `{triggered ? (...)}` pelo painel honesto:

```diff
+ import { EmergencyController, newClientId } from '@irisflow/comm-client';
+ import { EmergencyStatusPanel } from './EmergencyStatusPanel';
+ import { useComm } from '../../context/CommContext';
```

```tsx
const { client, patientId, activeAlert } = useComm();
const [estado, setEstado] = useState<EmergencyState>('CANCELADO');

const controller = useRef(
  new EmergencyController({
    supabase: client?.supabase ?? null,
    patientId,
    // O alarme local já existe e já funciona sem rede. Ele continua sendo a
    // camada confiável; o que muda é só o que a TELA promete.
    startLocalAlarm: () => { /* som + fala, o código que já está aqui */ },
    stopLocalAlarm:  () => { /* parar som + fala */ },
    onStateChange: setEstado,
  }),
).current;

const triggerAlert = (id: string, label: string) => {
  // dispara som e voz exatamente como hoje…
  void controller.trigger(newClientId(), id as EmergencyCategory);
};

// Realtime do CommContext empurra o estado real de volta.
useEffect(() => {
  if (activeAlert) controller.applyServerState(activeAlert);
}, [activeAlert, controller]);
```

```diff
- {triggered ? (
-   <div role="alert">
-     <h2>{escalated ? 'ALERTA ESCALADO' : t('emergency.alertSent')}</h2>
-     ...
-   </div>
- ) : (
+ {estado !== 'CANCELADO' ? (
+   <EmergencyStatusPanel
+     state={estado}
+     triggeredAt={activeAlert?.triggered_at ?? null}
+   />
+ ) : (
```

O `EmergencyStatusPanel` lê `describeState()` — a **mesma** função que decide
se o alarme continua tocando. Uma fonte só para as duas coisas é o que impede
a tela de dizer "confirmado" enquanto o som ainda toca, ou o contrário.

O timer de escalonamento de 15 s pode sair: o escalonamento agora é do
servidor (`emergency-dispatch`), que sabe se **algum** cuidador confirmou —
coisa que o cliente não tem como saber.

---

## 7. `AuthContext.tsx` — o PIN deixa de valer como autorização

Mudança pequena e importante. `loginCaregiver(pin)` continua existindo e
continua funcionando como **trava local de tela**: impedir que o paciente
entre sem querer na área do cuidador pelo olhar. O que ele para de fazer é
conceder acesso a dados remotos — isso passa a ser exclusivamente o JWT do
Supabase.

```diff
  const loginCaregiver = (pin: string) => {
-   // TEMPORÁRIO: PIN vem de env var. Substituir por autenticação no backend.
+   // Trava local de TELA, não autorização de dados. Existe para o paciente
+   // não abrir a área do cuidador por acidente durante a navegação por
+   // olhar. Acesso a mensagens e alertas é decidido pela RLS do Postgres a
+   // partir do JWT, e um PIN correto aqui não abre nada no servidor.
    if (pin === env.caregiverPin) {
      setIsCaregiver(true);
-     // Placeholder para JWT — hoje é um marcador local.
-     setAuthToken('local-caregiver-session');
+     setAuthToken(null);   // não existe token local; quem autentica é o Supabase
      return true;
    }
    return false;
  };
```

`mockProfiles` pode ficar: sem configuração de Supabase o app segue
funcionando com eles, como hoje.

---

## 8. Verificar

```bash
cd Desktop/blink/Blinkv1/frontend
npm run verify
```

Esperado: lint limpo, type-check limpo, os testes existentes passando e build
concluído. Se algum teste de `EmergencyEscalation.test.tsx` falhar, é porque
ele afirma o texto antigo `t('emergency.alertSent')` — atualize a expectativa
para o novo estado; a mudança de comportamento é o objetivo.

Sem `.env.local`, o app deve abrir e navegar **idêntico** ao de antes. Vale
conferir isso explicitamente: é a garantia de que a nova camada é
desacoplada de verdade.

---

## 9. Primeiro pareamento

1. No app do cuidador, crie a conta (ou use a do site).
2. No desktop, área do cuidador, cadastre o paciente e gere o código
   (`create_link_invite`).
3. No celular, "Vincular paciente", digite as 8 letras.
4. O vínculo e a conversa nascem juntos. A partir daí, `/caregiver-chat`
   funciona.

---

## Resumo do que foi tocado

| Arquivo | Natureza |
|---|---|
| `config/commEnv.ts` | novo |
| `context/CommContext.tsx` | novo |
| `utils/patientSession.ts` | novo |
| `pages/caregiver/TalkToCaregiverScreen.tsx` | novo |
| `pages/caregiver/CaregiverChatHistory.tsx` | novo |
| `pages/output/EmergencyStatusPanel.tsx` | novo |
| `App.tsx` | +1 provider, +2 rotas |
| `pages/MainMenu.tsx` | +1 item |
| `i18n/locales/*.json` | +2 chaves |
| `pages/output/EmergencyEscalation.tsx` | painel de estado real no lugar da afirmação fixa |
| `context/AuthContext.tsx` | PIN deixa de emitir token |
| `utils/api.ts` | **intocado** |
| pipeline de rastreamento | **intocado** |
