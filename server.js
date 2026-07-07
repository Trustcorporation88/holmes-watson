// ============================================================
// AGENTE HOLMES — Backend (Railway)
// Claude = investigador principal | DeepSeek = revisora cega (opcional)
// As chaves vivem SOMENTE aqui, em variáveis de ambiente.
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY; // opcional
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY; // opcional (anti-bot)
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;     // opcional (anti-bot)
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

app.get('/api/saude', (_req, res) => res.json({
  ok: true,
  investigador: ANTHROPIC_KEY ? 'claude' : (DEEPSEEK_KEY ? 'deepseek (modo de teste)' : false),
  revisora: Boolean(ANTHROPIC_KEY && DEEPSEEK_KEY),
  buscaWeb: Boolean(ANTHROPIC_KEY),
  pdf: Boolean(ANTHROPIC_KEY),
  turnstileSiteKey: TURNSTILE_SITE_KEY || null
}));

app.listen(PORT, () => console.log(`Agente Holmes investigando na porta ${PORT}`));
