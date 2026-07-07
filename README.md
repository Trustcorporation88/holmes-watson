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

## Proteções incluídas

- Rate limit de 15 requisições/minuto por IP (proteção básica de custo).
- Limite de tamanho de mensagem e de histórico.
- Anonimização automática antes do envio ao segundo provedor.
- Chaves nunca expostas ao navegador; `.env` fora do git.

## Custos estimados

O Claude responde com até ~1.200 tokens por turno e a DeepSeek com até 500 — uso casual do demo custa centavos. Se o site for público, acompanhe o consumo nos painéis da Anthropic e da DeepSeek e ajuste o rate limit em `server.js` se necessário.

## Avisos

O Agente Holmes presta apoio técnico-jurídico e não substitui advogado inscrito na OAB. A jurisprudência citada deve ser conferida nas fontes oficiais antes de fundamentar peça protocolada. Ao usar o site com dados reais de clientes, prefira anonimizar os fatos na própria pergunta.
