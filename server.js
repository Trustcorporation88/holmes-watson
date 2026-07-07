// ============================================================
// AGENTE HOLMES — Backend (Railway)
// Claude = investigador principal | DeepSeek = revisora cega (opcional)
// As chaves vivem SOMENTE aqui, em variáveis de ambiente.
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY; // opcional
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
app.post('/api/chat', limitar, async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
      return res.status(400).json({ erro: 'Histórico de mensagens inválido.' });
    }

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: PROMPT_HOLMES,
        messages: messages.map(m => ({ role: m.role, content: String(m.content).slice(0, 20_000) }))
      })
    });

    const dados = await resposta.json();
    if (!resposta.ok) {
      console.error('Erro Anthropic:', dados);
      return res.status(502).json({ erro: 'O investigador está indisponível no momento.' });
    }
    const texto = (dados.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ texto });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Falha interna na investigação.' });
  }
});

// ---------- /api/contracheck — DeepSeek, a revisora cega ----------
app.post('/api/contracheck', limitar, async (req, res) => {
  try {
    if (!DEEPSEEK_KEY) return res.json({ disponivel: false });
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
  investigador: Boolean(ANTHROPIC_KEY),
  revisora: Boolean(DEEPSEEK_KEY)
}));

app.listen(PORT, () => console.log(`Agente Holmes investigando na porta ${PORT}`));
