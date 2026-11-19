# Licenças, Origem e Atribuição de Código de Terceiros

Este documento registra formalmente a auditoria de licenças e o reaproveitamento de código no projeto **Shopee Afiliados Bot**.

---

## 1. Projeto-Base Estrutural: `gabrieldamasse-01/bot-de-automacao`

- **Repositório:** https://github.com/gabrieldamasse-01/bot-de-automacao
- **Componentes reaproveitados e adaptados:**
  - Estrutura de configuração (`src/config/index.js`)
  - Utilitário de atrasos e formatação (`src/utils/delay.js`)
  - Extração de URLs e preços (`src/utils/regex.js`)
  - Logger com níveis (`src/utils/logger.js`)
  - Lógica conceitual de fila FIFO com retentativas e backoff (`src/services/queue/dispatcher.js`) e listener de grupos com deduplicação (`src/services/groups/listener.js`)
- **Componentes removidos integralmente:**
  - `whatsapp-web.js`, `puppeteer`, Chromium e comandos específicos de Windows (`start ""`)
- **Divergência de licença detectada na auditoria:**
  - O arquivo `package.json` original declara `"license": "ISC"`.
  - O arquivo `README.md` original declara `MIT`.
  - Não existe arquivo `LICENSE` na raiz do repositório.
- **Conduta adotada:**
  - O código adaptado mantém atribuição explícita ao autor **Gabriel Damasse** neste documento e nos cabeçalhos dos módulos adaptados.
  - **Pendência jurídica recomendada antes de publicação/distribuição open-source pública:** caso o proprietário deseje tornar o repositório público no GitHub no futuro, recomenda-se solicitar confirmação formal de licença (ISC ou MIT) ao autor ou isolar/substituir os arquivos adaptados remanescentes. Para uso privado/interno, a atribuição e o registro estão documentados.

---

## 2. Referência Técnica da API Shopee: `jeffmonteiroo/shopee-br-affiliate-mcp`

- **Repositório:** https://github.com/jeffmonteiroo/shopee-br-affiliate-mcp
- **Licença:** **MIT License** (`Copyright (c) 2026 Shopee Affiliate MCP contributors`) — arquivo `LICENSE` formal presente no repositório.
- **O que foi aproveitado como referência técnica em Node.js:**
  - Endpoint oficial brasileiro `https://open-api.affiliate.shopee.com.br/graphql`
  - Assinatura oficial `SHA256(AppId + Timestamp + Payload + Secret)` no cabeçalho `Authorization`
  - Contratos de queries e mutations (`productOfferV2` e `generateShortLink`) conferidos em `2026-10-01`
  - Regras de validação de até 5 Sub IDs, allowlist HTTPS anti-SSRF para resolução de links curtos (`shopee.com.br`, `www.shopee.com.br`, `s.shopee.com.br`, `shope.ee`), controle de orçamento horário (8.000/h) e mapeamento dos códigos de erro oficiais (`10000`–`11002`).
- **Aviso da licença MIT preservado abaixo:**

```text
MIT License

Copyright (c) 2026 Shopee Affiliate MCP contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. Referência Conceitual Complementar: `JVitor26/Projeto_afiliado`

- **Repositório:** https://github.com/JVitor26/Projeto_afiliado
- **Licença:** **Sem arquivo `LICENSE` e sem declaração de licença em `pyproject.toml`.**
- **Conduta adotada:** **Nenhum arquivo ou trecho de código foi copiado ou distribuído deste repositório.** Foi utilizado apenas como referência conceitual de boas práticas (ranqueamento por desconto/comissão/vendas, deduplicação de ofertas e filtros seguros).

---

## 4. Componentes Internos Reaproveitados do TITAN CRM

- **Origem:** Repositório local privado do próprio proprietário (`/home/kali/TITANCRM`).
- **Módulos adaptados com isolamento total de execução e estado:**
  - Motor WhatsApp Baileys (`@whiskeysockets/baileys`): padrão de `makeWASocket`, `determineReconnectDecision`, proteção de troca de socket e reconexão exponencial com jitter.
  - `src/whatsapp/message_normalizer.js`: desempacotamento e extração de texto de mensagens Baileys.
  - `src/whatsapp/trava_sessao.js`: trava distribuída em Redis para impedir duas instâncias usando a mesma sessão WhatsApp.
  - `src/utils/filtro_log_criptografia.js`: sanitização de chaves de sessão Signal/Baileys no console.
- **Isolamento:** Nenhuma credencial, sessão WhatsApp, banco de dados ou processo do TITAN é compartilhado ou modificado.
