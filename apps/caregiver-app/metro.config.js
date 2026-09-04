/**
 * Metro precisa de ajuda para enxergar `packages/comm-client`.
 *
 * O `npm install file:../../packages/comm-client` cria um symlink em
 * `node_modules/@irisflow/comm-client`, mas o Metro, por padrão, só observa
 * e transpila arquivos DENTRO da raiz do projeto. O pacote fica fora dela,
 * e o import falha com "Unable to resolve module".
 *
 * Duas configurações resolvem, e cada uma cobre uma metade do problema:
 *
 *   watchFolders     — põe o diretório do pacote sob o alcance do Metro, para
 *                      ele transpilar o TypeScript de lá e recarregar quando
 *                      esses arquivos mudarem.
 *
 *   nodeModulesPaths — mantém a resolução de dependências apontando para o
 *                      `node_modules` DESTE app. Sem isso, o `react` que o
 *                      comm-client eventualmente alcançasse poderia ser uma
 *                      segunda cópia — a origem clássica do
 *                      "Invalid hook call".
 *
 * Vale para web, Android e iOS igualmente: é resolução de módulo, não
 * configuração de plataforma.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(workspaceRoot, 'packages/comm-client')];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// `unstable_enableSymlinks` não existe mais: seguir symlink virou o padrão do
// Metro. `disableHierarchicalLookup` continua valendo — sem ele, o Metro sobe
// a árvore de diretórios procurando `node_modules` e pode achar uma segunda
// cópia do React fora do projeto, que é a origem clássica do "Invalid hook
// call".
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
