# AGENTE HOLMES — Site + Backend (Railway)

Investigação jurídica com IA em arquitetura de dupla checagem: **Claude** como investigador principal e **DeepSeek (Watson)** como revisora cega opcional. As chaves de API vivem apenas no servidor.

## Arquitetura

```
Navegador do visitante
      │  (nenhuma chave trafega aqui)
      ▼
Backend Express no Railway
      ├── POST /api/chat        → API da Anthropic (Claude = Holmes, investigador)
      ├── POST /api/contracheck → API da DeepSeek (Watson, revisora cega) [opcional]
      └── GET  /api/saude       → status das duas integrações
```

O contra-check segue o princípio da **revisão cega**: a Watson recebe apenas a análise final — sem o caso original nem o raciocínio — e audita exclusivamente lógica e consistência interna (contradições, saltos lógicos, pedidos incoerentes, precedentes citados sem número identificável). Ela **não** verifica jurisprudência, porque LLM não é fonte; jurisprudência se confere no STF/STJ/TST. Antes do envio à DeepSeek, o servidor anonimiza CPF, CNPJ, número de processo, e-mail e telefone (LGPD/sigilo profissional).

## Deploy no Railway (Pro)

1. Crie um repositório no GitHub com estes arquivos (`server.js`, `package.json`, pasta `public/`).
2. No Railway: **New Project → Deploy from GitHub repo** e selecione o repositório. O Railway detecta Node automaticamente e roda `npm start`.
3. Em **Variables**, adicione:
   - `ANTHROPIC_API_KEY` — obrigatória (obtenha em console.anthropic.com).
   - `DEEPSEEK_API_KEY` — opcional (platform.deepseek.com). Sem ela, o botão de contra-check simplesmente não aparece no site; todo o resto funciona.
4. Em **Settings → Networking**, clique em **Generate Domain** para obter a URL pública (ou aponte um domínio próprio).
5. Abra a URL. Teste `https://SEU-DOMINIO/api/saude` — deve responder `{"ok":true,"investigador":true,"revisora":true}`.

## Rodando localmente (opcional)

```bash
npm install
cp .env.example .env   # preencha as chaves
node --env-file=.env server.js
```

No Windows/PowerShell:

```powershell
npm install
Copy-Item .env.example .env   # edite e preencha as chaves
node --env-file=.env server.js
# depois abra http://localhost:3000
```

## Funcionalidades

- **Chat com streaming** — a resposta do Holmes surge em tempo real.
- **Busca na web** (com ANTHROPIC_API_KEY) — o investigador verifica jurisprudência e fontes atuais, até 3 consultas por resposta.
- **Anexo de PDF** — contratos analisados no documento real (Módulos A e E), limite 6MB.
- **Contas e casos salvos** (com DATABASE_URL) — registro/login com senha criptografada (bcrypt) e sessões JWT; até 50 casos por usuário, com salvar, reabrir e apagar.
- **Dossiê em PDF** — exporta a investigação com timbre, data, paginação e aviso OAB.
- **Contra-check Watson** (com as duas chaves de IA) — revisão cega cruzada.
- **Turnstile** (com as chaves TURNSTILE_*) — anti-bot invisível da Cloudflare.

Cada funcionalidade liga sozinha quando sua variável existe e se desliga sem quebrar nada quando ausente.

## Banco de dados (casos salvos)

1. No projeto Railway: **Create → Database → Add PostgreSQL**.
2. No serviço holmes-watson → **Variables → New Variable → Add Reference** → selecione `DATABASE_URL` do Postgres criado.
3. Adicione também `JWT_SECRET` com uma frase longa aleatória (sem ela, cada redeploy desconecta os usuários logados).
4. O servidor cria as tabelas sozinho no primeiro boot.

## Proteções incluídas

- Rate limit de 15 requisições/minuto por IP (proteção básica de custo).
- Limite de tamanho de mensagem e de histórico.
- Anonimização automática antes do envio ao segundo provedor.
- Chaves nunca expostas ao navegador; `.env` fora do git.

## Custos estimados

O Claude responde com até ~1.200 tokens por turno e a DeepSeek com até 500 — uso casual do demo custa centavos. Se o site for público, acompanhe o consumo nos painéis da Anthropic e da DeepSeek e ajuste o rate limit em `server.js` se necessário.

## Avisos

O Agente Holmes presta apoio técnico-jurídico e não substitui advogado inscrito na OAB. A jurisprudência citada deve ser conferida nas fontes oficiais antes de fundamentar peça protocolada. Ao usar o site com dados reais de clientes, prefira anonimizar os fatos na própria pergunta.

---

## Oráculo — 19 agentes especialistas (v2.1)

Além do Holmes (investigador generalista, padrão), o chat agora tem 19 agentes especialistas selecionáveis no dropdown acima do campo de mensagem, ou invocáveis por comando na própria conversa:

- Atalhos: `/civil`, `/tributario`, `/fiscal`, `/holding`, `/execucao`, `/rj`, `/lgpd`, `/ma`, `/criminal`, `/contratos`, `/societario`, `/imobiliario`, `/bancario`, `/consumidor`, `/ambiental`, `/compliance`, `/marketing`, `/vendas`, `/trabalhista`
- Ou: `chamar [nome do agente]` (ex.: `chamar carrasco cível`)
- `execute` ou `oráculo` ativa o Oráculo Master (modo War Room multi-área)

Os agentes herdam toda a infraestrutura existente: anexos (PDF/imagem nativos, Word/Excel extraídos), consulta oficial DataJud, busca na web para confirmar jurisprudência, streaming, contra-check da revisora e cache de prompt.

**Arquivos:** `oraculo.js` (prompts e roteador) + edições mínimas em `server.js` e `public/index.html`. Sem agente selecionado, o comportamento é 100% o anterior (Holmes).

**Variáveis opcionais:** `ORACULO_MODEL` (padrão `claude-sonnet-4-6`) e `ORACULO_MODEL_HEAVY` (padrão `claude-opus-4-8`, usado pelos 8 agentes de raciocínio pesado: Master, Deal Killer, Auditor Letal, Arquiteto Fiscal, Executor RJ, Predador Criminal, Predador Societário e Holding). Atenção ao custo do Opus em conversas com PDFs longos.
