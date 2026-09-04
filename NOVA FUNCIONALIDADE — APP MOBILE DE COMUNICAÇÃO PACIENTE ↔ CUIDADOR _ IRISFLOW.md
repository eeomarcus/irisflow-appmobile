# NOVA FUNCIONALIDADE — APP MOBILE DE COMUNICAÇÃO PACIENTE ↔ CUIDADOR | IRISFLOW

Você está trabalhando no projeto IrisFlow, uma plataforma de tecnologia assistiva que permite que pessoas com restrição motora severa e preservação do controle ocular se comuniquem e controlem um computador através do olhar.

## 1. CONTEXTO DO PRODUTO

A aplicação principal da IrisFlow já possui:

- Rastreamento ocular por webcam;
- Calibração individual;
- Comunicação por teclado virtual;
- Frases rápidas;
- Pictogramas;
- Síntese de voz;
- Controle do computador;
- Painel do cuidador;
- Histórico de solicitações de ajuda;
- Sistema de emergência;
- Configurações de sensibilidade;
- Processamento local do rastreamento ocular;
- Funcionamento offline para o núcleo de rastreamento e comunicação.

O objetivo agora é criar um novo produto complementar:

# APP MOBILE IRISFLOW

O aplicativo mobile será integrado à aplicação principal e terá como principal objetivo criar um canal de comunicação bidirecional entre:

**PACIENTE ↔ CUIDADOR**

A comunicação deve funcionar tanto para situações simples do cotidiano quanto para situações de urgência/emergência.

A ideia não é substituir a aplicação principal. O APP será uma extensão dela, permitindo que o cuidador acompanhe e se comunique com o paciente mesmo quando estiver longe do computador.

---

# 2. OBJETIVO PRINCIPAL

Criar um aplicativo mobile moderno, acessível e extremamente simples de usar que permita:

### Paciente → Cuidador

O paciente poderá enviar:

- Mensagens de texto;
- Frases rápidas;
- Respostas "SIM";
- Respostas "NÃO";
- Pedidos básicos;
- Solicitação de ajuda;
- Alertas de emergência;
- Mensagens personalizadas;
- Possivelmente mensagens geradas pelo sistema de comunicação da IrisFlow.

Exemplos:

"Estou com sede."

"Preciso ir ao banheiro."

"Estou com dor."

"Quero mudar de posição."

"Preciso de ajuda."

"Venha aqui."

"Estou bem."

"URGENTE — PRECISO DE AJUDA."

O paciente não deve precisar digitar essas mensagens manualmente. A interface deve ser otimizada para seleção pelo olhar e utilizar os recursos já existentes da IrisFlow.

---

### Cuidador → Paciente

O cuidador poderá enviar:

- Mensagens de texto;
- Frases rápidas;
- Perguntas;
- Respostas;
- Confirmações;
- Solicitações simples;
- Mensagens personalizadas.

Exemplos:

"Estou indo aí."

"Você está bem?"

"Precisa de alguma coisa?"

"Estou no outro quarto."

"Já vou."

"Você precisa de ajuda?"

---

# 3. COMUNICAÇÃO EM TEMPO REAL

A comunicação deve ser próxima de um aplicativo de mensagens moderno.

Precisamos considerar:

- Mensagens em tempo real;
- Status online/offline;
- Entrega da mensagem;
- Leitura da mensagem;
- Timestamp;
- Reconexão automática;
- Persistência das mensagens;
- Histórico de conversas;
- Notificações push;
- Funcionamento adequado com internet instável;
- Tratamento de perda temporária de conexão.

Não presuma que WebSocket, Firebase, Supabase ou qualquer outra tecnologia deve ser utilizada.

Primeiro:

1. Analise o projeto atual.
2. Descubra qual backend já existe.
3. Descubra banco de dados, autenticação e APIs existentes.
4. Identifique se existe infraestrutura que possa ser reutilizada.
5. Só então escolha a tecnologia necessária.

NÃO crie uma segunda arquitetura desnecessariamente se o projeto já possuir infraestrutura adequada.

---

# 4. SISTEMA DE EMERGÊNCIA

Este é um dos pontos mais importantes.

A IrisFlow já possui um botão de emergência na aplicação principal.

O novo sistema deve permitir que o paciente acione uma emergência usando o olhar.

Quando acionado:

1. Mostrar uma confirmação visual clara.
2. Evitar acionamentos acidentais.
3. Registrar o evento.
4. Enviar imediatamente o alerta para o cuidador.
5. Gerar uma notificação de alta prioridade no APP.
6. Mostrar claramente que o alerta foi enviado.
7. Registrar horário do acionamento.
8. Registrar quando o cuidador recebeu.
9. Registrar quando o cuidador visualizou.
10. Permitir que o cuidador confirme que recebeu o alerta.

IMPORTANTE:

Não trate uma notificação push comum como garantia de emergência.

O sistema deve possuir estados claros:

- ALERTA_DISPARADO
- ENVIANDO
- ENTREGUE
- VISUALIZADO
- CONFIRMADO
- CANCELADO
- FALHA_DE_ENVIO

Também deve existir tratamento para:

- Celular sem internet;
- Computador sem internet;
- Cuidador offline;
- Aplicativo fechado;
- Falha no servidor;
- Falha de push notification.

Se a arquitetura permitir, considerar um mecanismo de fallback.

Não invente integração com serviços externos sem verificar previamente a arquitetura e as possibilidades reais.

---

# 5. NÍVEIS DE URGÊNCIA

Crie uma estrutura de prioridade para mensagens.

Por exemplo:

### NORMAL

Mensagens cotidianas.

Exemplo:

"Quero água."

### IMPORTANTE

Necessidade que exige atenção em breve.

Exemplo:

"Preciso mudar de posição."

### URGENTE

Necessidade imediata.

Exemplo:

"Preciso de ajuda."

### EMERGÊNCIA

Situação crítica.

Exemplo:

"EMERGÊNCIA — PRECISO DE AJUDA AGORA."

Cada nível deve possuir comportamento visual e de notificação apropriado.

Evite excesso de cores, animações ou elementos que possam confundir o usuário.

---

# 6. PERFIS E VÍNCULO

O sistema precisa diferenciar claramente:

### PACIENTE

Pessoa que utiliza a aplicação principal IrisFlow.

### CUIDADOR

Pessoa responsável por acompanhar o paciente.

Precisamos criar um relacionamento seguro:

Paciente ↔ Cuidador

Não permitir que qualquer pessoa consiga visualizar ou enviar mensagens para um paciente.

Avalie uma arquitetura de:

- Conta;
- Perfil;
- Paciente;
- Cuidador;
- Vínculo/relacionamento;
- Permissões.

O cuidador poderá estar vinculado a um ou mais pacientes no futuro, então evite criar uma arquitetura limitada a apenas um paciente.

---

# 7. AUTENTICAÇÃO

Analise o sistema atual antes de implementar.

Se já existir autenticação:

- Reutilize-a;
- Não crie outro sistema de login desnecessariamente;
- Mantenha os mesmos conceitos de usuário.

Se não existir autenticação adequada, proponha uma solução.

O APP deve considerar:

- Login;
- Sessão persistente;
- Logout;
- Recuperação de acesso;
- Proteção de sessão;
- Controle de acesso;
- Vinculação segura entre paciente e cuidador.

---

# 8. NOTIFICAÇÕES

O cuidador deve receber notificações quando:

- Paciente enviar mensagem;
- Paciente enviar mensagem urgente;
- Paciente acionar emergência;
- Paciente solicitar ajuda;
- Houver alguma situação que exija atenção.

O paciente também deve receber notificações quando:

- Cuidador responder;
- Cuidador confirmar emergência;
- Cuidador enviar mensagem;
- Cuidador responder uma solicitação.

As notificações devem ser pensadas para Android e iOS.

Não implemente notificações falsas ou simuladas.

---

# 9. INTERFACE DO PACIENTE

A aplicação principal continuará sendo utilizada pelo paciente.

A nova funcionalidade deve ser integrada à interface atual.

Criar uma nova área:

## "Comunicar com cuidador"

Essa área deve ser extremamente simples.

Prioridade:

1. Emergência
2. Pedir ajuda
3. SIM
4. NÃO
5. Frases rápidas
6. Mensagens
7. Histórico

Os elementos precisam respeitar os princípios já utilizados pela IrisFlow:

- Alvos grandes;
- Poucos elementos por tela;
- Alto contraste;
- Hierarquia visual clara;
- Feedback visual de seleção;
- Navegação simples;
- Elementos de escape consistentes;
- Operação completa por fixação ocular.

NÃO criar uma interface convencional de smartphone para o paciente.

A interface precisa continuar sendo pensada para uma pessoa que controla a aplicação pelo olhar.

---

# 10. INTERFACE DO CUIDADOR

O aplicativo mobile do cuidador deve ter uma interface convencional de smartphone, mas extremamente simples.

Tela principal:

- Paciente;
- Status do paciente;
- Última mensagem;
- Estado da conexão;
- Alertas;
- Botão para abrir conversa.

Tela de conversa:

- Histórico;
- Mensagens do paciente;
- Mensagens do cuidador;
- Timestamp;
- Status de entrega;
- Status de leitura;
- Campo de mensagem;
- Frases rápidas;
- Botões de resposta rápida.

Exemplo:

Paciente:
> "Preciso de água."

Cuidador:
> "Estou indo."

Paciente:
> "Obrigado."

---

# 11. STATUS DO PACIENTE

Avalie a possibilidade de apresentar:

- Online;
- Offline;
- IrisFlow em execução;
- Última atividade;
- Última comunicação;
- Estado da conexão;
- Último alerta;
- Último pedido de ajuda.

IMPORTANTE:

Não transformar o sistema em um mecanismo invasivo de vigilância.

O foco é comunicação e segurança, não monitoramento constante.

---

# 12. PRIVACIDADE E SEGURANÇA

A IrisFlow possui como princípio importante o processamento local dos dados de visão computacional.

A nova arquitetura NÃO deve enviar:

- Frames da webcam;
- Imagens do paciente;
- Dados brutos da íris;
- Vetores de calibração;

para o servidor apenas para implementar o sistema de comunicação.

A comunicação deve transmitir somente os dados estritamente necessários.

Avalie cuidadosamente:

- Criptografia em trânsito;
- Criptografia em repouso;
- Controle de acesso;
- Separação entre pacientes;
- Proteção de mensagens;
- Tokens;
- Sessões;
- Logs;
- Retenção de dados;
- Exclusão de mensagens;
- Auditoria.

Como o produto trabalha com tecnologia assistiva e pode tratar dados pessoais sensíveis, não faça escolhas de arquitetura que aumentem exposição de dados sem necessidade.

---

# 13. OFFLINE / CONECTIVIDADE

A IrisFlow já valoriza funcionamento offline.

A comunicação remota obviamente depende de conectividade para chegar ao outro dispositivo.

Por isso, implemente uma estratégia robusta:

### Se houver internet:

Enviar imediatamente.

### Se perder internet:

- Não perder a mensagem;
- Armazenar temporariamente;
- Informar estado;
- Tentar reenviar automaticamente;
- Evitar mensagens duplicadas.

Para mensagens de emergência, tratar a falha de conectividade explicitamente.

Nunca mostrar "enviado" se o servidor não confirmou o recebimento.

---

# 14. BANCO DE DADOS

Antes de criar tabelas, analise o banco atual.

Proponha uma estrutura equivalente a:

users
patients
caregivers
patient_caregiver_relationships
conversations
messages
message_status
emergency_alerts
notifications

Mas NÃO implemente exatamente essa estrutura sem antes verificar a arquitetura existente.

Adapte ao padrão já utilizado no projeto.

A estrutura deve permitir evolução futura para:

- Mais de um cuidador;
- Mais de um paciente;
- Profissionais de saúde;
- Clínicas;
- Histórico;
- Permissões;
- Auditoria.

---

# 15. API / BACKEND

Analise as APIs atuais.

Crie apenas os endpoints necessários.

Possíveis operações:

- autenticação;
- obter conversas;
- enviar mensagem;
- receber mensagem;
- marcar como lida;
- enviar alerta;
- confirmar emergência;
- obter histórico;
- obter status do paciente;
- gerenciar vínculo paciente/cuidador.

Não crie endpoints redundantes.

Documente os contratos.

---

# 16. ARQUITETURA MOBILE

Antes de escolher a tecnologia mobile, avalie:

- React Native;
- Expo;
- Flutter;
- PWA;
- outra solução compatível.

A escolha deve levar em consideração:

- Android;
- iOS;
- notificações push;
- manutenção;
- integração com backend;
- reutilização de conhecimento/código existente;
- desempenho;
- acessibilidade.

Se React/TypeScript já for predominante no projeto, considere React Native/Expo como candidato natural, mas NÃO escolha automaticamente.

Explique a decisão antes de implementar.

---

# 17. NÃO QUEBRAR O PRODUTO EXISTENTE

REGRA CRÍTICA:

Não altere o funcionamento do rastreamento ocular.

Não altere:

- calibração;
- regressão;
- filtragem;
- seleção por fixação;
- processamento da webcam;
- modelo de visão computacional;

sem necessidade direta.

A nova funcionalidade deve ser desacoplada sempre que possível.

A comunicação deve ser uma nova camada do produto.

---

# 18. COMPATIBILIDADE COM A APLICAÇÃO ATUAL

Analise como a aplicação principal está estruturada.

Identifique:

- Frontend;
- Backend;
- IPC;
- Electron;
- APIs;
- Banco;
- Autenticação;
- Configuração;
- Estado global;
- Componentes reutilizáveis;
- Sistema de notificações existente.

Crie um mapa de integração antes de alterar arquivos.

---

# 19. FLUXO PRINCIPAL

Implemente este fluxo conceitual:

PACIENTE

IrisFlow Desktop
↓
Comunicação
↓
Seleciona "Falar com cuidador"
↓
Seleciona frase/mensagem
↓
Sistema registra mensagem
↓
Backend
↓
Cuidador recebe no APP
↓
Notificação
↓
Cuidador abre conversa
↓
Responde
↓
Backend
↓
IrisFlow Desktop
↓
Paciente recebe a resposta

---

# 20. FLUXO DE EMERGÊNCIA

PACIENTE
↓
Botão EMERGÊNCIA
↓
Confirmação por fixação
↓
ALERTA_DISPARADO
↓
Backend
↓
Push notification
↓
APP DO CUIDADOR
↓
"🚨 EMERGÊNCIA"
↓
Cuidador abre alerta
↓
CONFIRMAR RECEBIMENTO
↓
IrisFlow recebe confirmação
↓
Paciente visualiza:

"Seu cuidador recebeu o alerta."

---

# 21. EXPERIÊNCIA DE USO

A regra principal é:

## O paciente não deve precisar entender tecnologia para utilizar o sistema.

Evitar:

- Menus complexos;
- Muitas opções;
- Textos longos;
- Pequenos botões;
- Interfaces cheias;
- Fluxos com muitas etapas;
- Configurações técnicas expostas.

A aplicação deve transmitir:

"Eu quero comunicar algo → escolho → o cuidador recebe."

---

# 22. QUALIDADE

O projeto atual possui uma preocupação forte com testes automatizados.

A nova funcionalidade também deve possuir testes.

Criar testes para:

- autenticação;
- permissões;
- vínculo paciente/cuidador;
- envio de mensagens;
- recebimento;
- mensagens duplicadas;
- reconexão;
- mensagens offline;
- status de entrega;
- status de leitura;
- emergência;
- confirmação de emergência;
- falha de servidor;
- usuário sem permissão;
- notificações;
- histórico.

Não considerar a funcionalidade concluída apenas porque a interface funciona.

---

# 23. SEGURANÇA

Faça uma análise específica contra:

- acesso indevido a conversas;
- IDOR;
- alteração de patient_id;
- alteração de caregiver_id;
- acesso a pacientes não vinculados;
- replay de requisições;
- tokens inválidos;
- sessões expiradas;
- mensagens duplicadas;
- abuso do endpoint de emergência;
- spam;
- enumeração de usuários;
- exposição de dados pessoais.

Corrija vulnerabilidades encontradas.

Não utilize dados sensíveis reais durante testes.

---

# 24. O QUE VOCÊ DEVE FAZER AGORA

NÃO comece codificando imediatamente.

Execute as seguintes etapas:

## ETAPA 1 — AUDITORIA

Analise profundamente o repositório atual.

Identifique:

- estrutura de pastas;
- stack;
- frontend;
- backend;
- banco;
- autenticação;
- APIs;
- Electron;
- comunicação interna;
- gerenciamento de estado;
- testes;
- configurações;
- deploy.

## ETAPA 2 — MAPA DA ARQUITETURA

Crie um documento:

`docs/mobile-caregiver-architecture.md`

Descrevendo:

- arquitetura atual;
- arquitetura proposta;
- fluxo de dados;
- entidades;
- APIs;
- autenticação;
- notificações;
- comunicação em tempo real;
- emergência;
- offline;
- segurança.

## ETAPA 3 — PLANO DE IMPLEMENTAÇÃO

Crie:

`docs/mobile-caregiver-implementation-plan.md`

Divida em fases pequenas e testáveis.

Exemplo:

Fase 1 — Backend/base de dados
Fase 2 — Autenticação
Fase 3 — Relacionamento paciente/cuidador
Fase 4 — Conversas
Fase 5 — Tempo real
Fase 6 — APP mobile
Fase 7 — Push notifications
Fase 8 — Emergência
Fase 9 — Integração com desktop
Fase 10 — Testes
Fase 11 — Segurança
Fase 12 — Build e deploy

## ETAPA 4 — IMPLEMENTAÇÃO

Depois da auditoria e do plano, implemente a funcionalidade por etapas.

Não faça uma alteração gigantesca de uma vez.

Após cada fase:

- rode testes;
- verifique TypeScript;
- verifique lint;
- verifique build;
- valide integração;
- documente alterações.

---

# 25. REGRAS IMPORTANTES PARA VOCÊ

1. Não invente arquivos existentes.
2. Não invente APIs existentes.
3. Não invente banco de dados.
4. Não substitua tecnologias sem necessidade.
5. Não reescreva o projeto.
6. Não altere o núcleo do rastreamento ocular sem necessidade.
7. Não remova funcionalidades existentes.
8. Não use mocks como solução final.
9. Não considere uma tela bonita como funcionalidade concluída.
10. Priorize arquitetura simples e sustentável.
11. Priorize segurança.
12. Priorize acessibilidade.
13. Priorize confiabilidade da comunicação.
14. Toda decisão arquitetural relevante deve ser explicada.
15. Se encontrar um problema no código existente que impeça a implementação, informe antes de criar uma solução paralela.
16. Reutilize componentes e infraestrutura existentes sempre que fizer sentido.
17. Não adicione dependências desnecessárias.
18. Não exponha dados de visão computacional pela rede.
19. Não trate push notification como garantia absoluta de emergência.
20. Não faça promessas de entrega que a infraestrutura não consegue garantir.

---

# 26. RESULTADO ESPERADO

Ao final, queremos ter uma arquitetura na qual:

                 ┌─────────────────────┐
                 │   IRISFLOW DESKTOP  │
                 │       PACIENTE      │
                 └──────────┬──────────┘
                            │
                            │ mensagens
                            │ emergência
                            │ status
                            ▼
                 ┌─────────────────────┐
                 │       BACKEND       │
                 │ autenticação        │
                 │ mensagens           │
                 │ notificações        │
                 │ emergência          │
                 │ permissões          │
                 └──────────┬──────────┘
                            │
                            │ tempo real
                            │ push
                            ▼
                 ┌─────────────────────┐
                 │     APP MOBILE      │
                 │      CUIDADOR       │
                 └─────────────────────┘

E também:

CUIDADOR
↓
APP MOBILE
↓
mensagem
↓
BACKEND
↓
IRISFLOW DESKTOP
↓
PACIENTE

O objetivo final é transformar a IrisFlow de uma plataforma que permite ao paciente se comunicar por meio do computador em uma plataforma que também mantém o paciente conectado ao seu cuidador.

A comunicação deve ser:

**simples, rápida, acessível, segura e confiável.**

Comece pela auditoria do repositório. Antes de modificar código, apresente:

1. Arquitetura atual encontrada;
2. Stack atual;
3. Como a nova funcionalidade pode ser integrada;
4. Tecnologias candidatas para o APP mobile;
5. Arquitetura recomendada;
6. Estrutura de banco/API proposta;
7. Estratégia de tempo real;
8. Estratégia de notificações;
9. Estratégia de emergência;
10. Plano de implementação em fases;
11. Riscos técnicos identificados.

Depois disso, aguarde minha aprovação para iniciar a implementação.