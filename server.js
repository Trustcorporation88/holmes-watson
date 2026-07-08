// ============================================================
// AGENTE HOLMES — Backend (Railway)
// Claude = investigador principal | DeepSeek = revisora cega (opcional)
// As chaves vivem SOMENTE aqui, em variáveis de ambiente.
// ============================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY; // opcional
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY; // opcional (anti-bot)
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;     // opcional (anti-bot)
const DATABASE_URL = process.env.DATABASE_URL;              // opcional (login e casos salvos)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'); // defina JWT_SECRET para sessões sobreviverem a redeploys

// ---------- Banco de dados (Postgres do Railway) ----------
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /railway\.internal/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
  });
  pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS casos (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      titulo TEXT NOT NULL,
      historico JSONB NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT now(),
      atualizado_em TIMESTAMPTZ DEFAULT now()
    );
  `).then(() => console.log('Banco pronto: usuarios e casos'))
    .catch(e => { console.error('Falha ao preparar o banco:', e.message); pool = null; });
}

function autenticar(req, res, next) {
  if (!pool) return res.status(503).json({ erro: 'Contas desativadas neste servidor.' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão inválida ou expirada. Entre novamente.' });
  }
}
const PORT = process.env.PORT || 3000;

// Limite simples de requisições por IP (proteção básica de custo)
const janelas = new Map();
function limitar(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const agora = Date.now();
  const janela = janelas.get(ip) || [];
  const recentes = janela.filter(t => agora - t < 60_000);
  if (recentes.length >= 15) {
    return res.status(429).json({ erro: 'Muitas requisições. Aguarde um minuto.' });
  }
  recentes.push(agora);
  janelas.set(ip, recentes);
  next();
}

const PROMPT_HOLMES = `Você é o AGENTE HOLMES, investigador jurídico sênior especialista em Direito Tributário, Sucessório, Civil e Trabalhista brasileiros, com padrão de atuação equivalente aos maiores escritórios do Brasil e dos EUA. Persona inspirada em Sherlock Holmes: dedutivo, preciso, elegante, ocasionalmente espirituoso — sempre tecnicamente impecável, em português do Brasil.

PRINCÍPIOS INEGOCIÁVEIS:
1. NUNCA invente julgados, súmulas, números de processo ou ementas. Cite preferencialmente Temas de Repercussão Geral do STF, Temas Repetitivos e Súmulas do STJ, Súmulas/OJs do TST e precedentes do CARF, identificados por número. Sem certeza da existência ou atualidade: diga "precedente a confirmar na pesquisa" e indique onde verificar.
2. Raciocine por silogismo explícito no mérito: premissa maior (norma + interpretação dos tribunais superiores), premissa menor (subsunção dos fatos), conclusão. Aponte onde a subsunção falha.
3. Dupla perspectiva sempre (autor E réu); antecipe os melhores contra-argumentos.
4. Risco classificado (baixo/médio/alto) com justificativa.
5. Prazos fatais (prescrição, decadência, recursos) alertados PRIMEIRO.
6. Honestidade profissional: tese fraca é dita fraca, com alternativa. Recuse estratégias ilícitas.
7. Redação sem juridiquês vazio nem hedging vago; atribuição específica ("o STJ, no Tema X, fixou que...").
8. Recomende anonimizar dados pessoais desnecessários (LGPD).

MÓDULOS (ative conforme o pedido):
A) CONTRATO: pergunte o lado do cliente e o objetivo; cláusula a cláusula com risco (🟢🟡🔴⚫), cláusulas AUSENTES, redação substitutiva pronta + argumento de negociação.
B) PROCESSO: decodifique o número CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO → Justiça e tribunal); peça movimentação/documentos ao usuário; audite nulidades (citação, art. 489 §1º CPC, prescrição, cerceamento) e sugira a defesa cabível na fase.
C) RED TEAM: persona do melhor advogado adversário; ataque tese/fatos/processo; nota de resiliência 0-10; depois blinde os pontos fracos.
D) AUDIÊNCIA: perguntas prováveis do juiz com respostas-modelo; sustentação em 3 atos.
E) DIFF: duas versões cláusula a cláusula; mudanças silenciosas perigosas.

FORMATO: respostas concisas para chat web — máximo ~350 palavras, sem tabelas markdown; parágrafos curtos e travessões. Alertas de prazo primeiro. Caso complexo: entregue o essencial e ofereça aprofundar. Em análise concreta, lembre que a revisão final cabe a advogado inscrito na OAB.`;

const PROMPT_REVISORA = `Você é uma revisora jurídica cega. Você recebe APENAS uma análise/peça jurídica pronta, sem acesso ao raciocínio que a gerou nem ao caso original. Sua função NÃO é verificar jurisprudência (você não tem acesso a fontes) — é auditar LÓGICA e CONSISTÊNCIA INTERNA:
1. Contradições internas (afirma X num parágrafo e não-X noutro; datas/valores que não batem).
2. Saltos lógicos: conclusões que não decorrem das premissas apresentadas.
3. Pedidos/recomendações incoerentes com a fundamentação exposta.
4. Ambiguidades que a parte contrária exploraria.
5. Afirmações categóricas apresentadas sem qualquer fundamento no próprio texto.
NÃO opine sobre a veracidade de precedentes citados — apenas marque se algum é citado sem identificação verificável (sem número de Tema/Súmula).
Responda em português do Brasil, em no máximo 200 palavras: "APROVADA SEM RESSALVAS" ou lista objetiva das falhas encontradas, cada uma em uma linha iniciada por "⚠".`;

// ---------- /api/chat — Claude, o investigador ----------
async function verificarTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true; // proteção desativada
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip })
    });
    const d = await r.json();
    return d.success === true;
  } catch { return false; }
}

app.post('/api/chat', limitar, async (req, res) => {
  try {
    const { messages, pdf, turnstileToken } = req.body;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
      return res.status(400).json({ erro: 'Histórico de mensagens inválido.' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    if (!(await verificarTurnstile(turnstileToken, ip))) {
      return res.status(403).json({ erro: 'Verificação anti-robô falhou. Recarregue a página e tente de novo.' });
    }

    const historico = messages.map(m => ({ role: m.role, content: String(m.content).slice(0, 20_000) }));

    // PDF anexado: entra como bloco de documento na última mensagem do usuário
    if (pdf && pdf.data && ANTHROPIC_KEY) {
      if (String(pdf.data).length > 8_000_000) {
        return res.status(400).json({ erro: 'PDF grande demais (limite ~6MB).' });
      }
      const ultima = historico[historico.length - 1];
      if (ultima && ultima.role === 'user') {
        ultima.content = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.data } },
          { type: 'text', text: ultima.content || 'Analise o documento anexado conforme os módulos aplicáveis.' }
        ];
      }
    }

    // Streaming para o cliente: texto puro em chunks
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // ---- Investigador principal: Claude, com busca na web e cache de prompt ----
    if (ANTHROPIC_KEY) {
      const resposta = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          stream: true,
          system: [{ type: 'text', text: PROMPT_HOLMES, cache_control: { type: 'ephemeral' } }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages: historico
        })
      });

      if (!resposta.ok) {
        const erro = await resposta.text();
        console.error('Erro Anthropic:', erro.slice(0, 500));
        return res.end('O investigador está indisponível no momento. Tente novamente em instantes.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let avisoBusca = false;
      for await (const chunk of resposta.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const linhas = buffer.split('\n');
        buffer = linhas.pop();
        for (const linha of linhas) {
          if (!linha.startsWith('data: ')) continue;
          const bruto = linha.slice(6).trim();
          if (bruto === '[DONE]') continue;
          try {
            const ev = JSON.parse(bruto);
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              res.write(ev.delta.text);
            } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use' && !avisoBusca) {
              avisoBusca = true;
              res.write('🔎 [consultando fontes na web…]\n\n');
            }
          } catch { /* linha parcial, ignora */ }
        }
      }
      return res.end();
    }

    // ---- Fallback de teste: DeepSeek (sem busca web e sem PDF) ----
    if (DEEPSEEK_KEY) {
      const resposta = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 1200,
          temperature: 0.4,
          messages: [{ role: 'system', content: PROMPT_HOLMES }, ...historico.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '[documento]').join(' ') }))]
        })
      });
      const dados = await resposta.json();
      if (!resposta.ok) { console.error('Erro DeepSeek:', dados); return res.end('O investigador está indisponível no momento.'); }
      return res.end(dados.choices?.[0]?.message?.content?.trim() || '');
    }

    return res.end('Nenhuma chave de IA configurada no servidor.');
  } catch (e) {
    console.error(e);
    try { res.end('\n\n[A investigação foi interrompida por uma falha. Envie novamente.]'); } catch {}
  }
});

// ---------- /api/contracheck — DeepSeek, a revisora cega ----------
app.post('/api/contracheck', limitar, async (req, res) => {
  try {
    // Revisão cruzada exige dois provedores distintos: sem a Anthropic, a DeepSeek estaria revisando a si mesma.
    if (!DEEPSEEK_KEY || !ANTHROPIC_KEY) return res.json({ disponivel: false });
    const { texto } = req.body;
    if (!texto || typeof texto !== 'string') return res.status(400).json({ erro: 'Texto ausente.' });

    // Anonimização básica antes de enviar ao segundo provedor (LGPD / sigilo)
    const anonimizado = texto
      .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[CPF]')
      .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '[CNPJ]')
      .replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, '[Nº PROCESSO]')
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '[EMAIL]')
      .replace(/\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}\b/g, '[TELEFONE]')
      .slice(0, 15_000);

    const resposta = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 500,
        temperature: 0.2,
        messages: [
          { role: 'system', content: PROMPT_REVISORA },
          { role: 'user', content: 'Audite a análise jurídica abaixo:\n\n' + anonimizado }
        ]
      })
    });

    const dados = await resposta.json();
    if (!resposta.ok) {
      console.error('Erro DeepSeek:', dados);
      return res.status(502).json({ erro: 'A revisora está indisponível no momento.' });
    }
    res.json({ disponivel: true, parecer: dados.choices?.[0]?.message?.content?.trim() || 'Sem parecer.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Falha interna na revisão.' });
  }
});


// ---------- Contas e casos salvos ----------
app.post('/api/registro', limitar, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ erro: 'Contas desativadas neste servidor.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (senha.length < 8) return res.status(400).json({ erro: 'A senha precisa de ao menos 8 caracteres.' });
    const hash = await bcrypt.hash(senha, 10);
    const r = await pool.query('INSERT INTO usuarios (email, senha_hash) VALUES ($1,$2) RETURNING id', [email, hash]);
    const token = jwt.sign({ id: r.rows[0].id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Este e-mail já tem conta. Use Entrar.' });
    console.error(e); res.status(500).json({ erro: 'Falha ao criar a conta.' });
  }
});

app.post('/api/login', limitar, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ erro: 'Contas desativadas neste servidor.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    const r = await pool.query('SELECT id, senha_hash FROM usuarios WHERE email = $1', [email]);
    if (!r.rows[0] || !(await bcrypt.compare(senha, r.rows[0].senha_hash))) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }
    const token = jwt.sign({ id: r.rows[0].id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Falha no login.' }); }
});

app.get('/api/casos', autenticar, async (req, res) => {
  const r = await pool.query('SELECT id, titulo, atualizado_em FROM casos WHERE usuario_id = $1 ORDER BY atualizado_em DESC LIMIT 50', [req.usuario.id]);
  res.json({ casos: r.rows });
});

app.post('/api/casos', autenticar, async (req, res) => {
  try {
    const { titulo, historico, casoId } = req.body;
    if (!Array.isArray(historico) || historico.length === 0) return res.status(400).json({ erro: 'Nada para salvar ainda.' });
    if (JSON.stringify(historico).length > 300_000) return res.status(400).json({ erro: 'Caso grande demais para salvar.' });
    const t = String(titulo || 'Caso sem título').slice(0, 120);
    if (casoId) {
      const r = await pool.query('UPDATE casos SET titulo=$1, historico=$2, atualizado_em=now() WHERE id=$3 AND usuario_id=$4 RETURNING id', [t, JSON.stringify(historico), casoId, req.usuario.id]);
      if (!r.rows[0]) return res.status(404).json({ erro: 'Caso não encontrado.' });
      return res.json({ id: r.rows[0].id, atualizado: true });
    }
    const total = await pool.query('SELECT COUNT(*) FROM casos WHERE usuario_id = $1', [req.usuario.id]);
    if (Number(total.rows[0].count) >= 50) return res.status(400).json({ erro: 'Limite de 50 casos salvos. Apague algum para continuar.' });
    const r = await pool.query('INSERT INTO casos (usuario_id, titulo, historico) VALUES ($1,$2,$3) RETURNING id', [req.usuario.id, t, JSON.stringify(historico)]);
    res.json({ id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Falha ao salvar o caso.' }); }
});

app.get('/api/casos/:id', autenticar, async (req, res) => {
  const r = await pool.query('SELECT id, titulo, historico FROM casos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.id]);
  if (!r.rows[0]) return res.status(404).json({ erro: 'Caso não encontrado.' });
  res.json(r.rows[0]);
});

app.delete('/api/casos/:id', autenticar, async (req, res) => {
  await pool.query('DELETE FROM casos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.usuario.id]);
  res.json({ ok: true });
});

app.get('/api/saude', (_req, res) => res.json({
  ok: true,
  investigador: ANTHROPIC_KEY ? 'claude' : (DEEPSEEK_KEY ? 'deepseek (modo de teste)' : false),
  revisora: Boolean(ANTHROPIC_KEY && DEEPSEEK_KEY),
  buscaWeb: Boolean(ANTHROPIC_KEY),
  pdf: Boolean(ANTHROPIC_KEY),
  turnstileSiteKey: TURNSTILE_SITE_KEY || null,
  contas: Boolean(pool)
}));

app.listen(PORT, () => console.log(`Agente Holmes investigando na porta ${PORT}`));
