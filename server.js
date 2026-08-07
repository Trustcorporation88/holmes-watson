// ============================================================
// AGENTE HOLMES — Backend (Railway)
// Investigador: Claude → OpenAI → DeepSeek (fallback em cascata)
// DeepSeek também atua como revisora cega (contra-check), se houver outra IA.
// As chaves vivem SOMENTE aqui, em variáveis de ambiente.
// ============================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { resolveAgent, listAgents } = require('./oraculo'); // ORÁCULO: 19 agentes especialistas (aditivo)
const { consultarEscavador, escavadorAtivo } = require('./escavador'); // ESCAVADOR: fallback pago do DataJud (ativa só com ESCAVADOR_TOKEN)

const app = express();
app.use(express.json({ limit: '150mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, caminho) => {
    if (caminho.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY; // opcional — fallback / alternativa ao Claude
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY; // opcional — último fallback + revisora cega
const ANTHROPIC_FILES_BETA = 'files-api-2025-04-14';
// Acima disso o PDF vai pela Files API (Messages API limita o body ~32MB com base64)
const CLAUDE_INLINE_PDF_MAX_MB = 12;
const OPENAI_PDF_MAX_MB = 45;
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY; // opcional (anti-bot)
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;     // opcional (anti-bot)
const DATABASE_URL = process.env.DATABASE_URL;              // opcional (login e casos salvos)
// Contas fechadas: só admin + 1 cliente (criados pelas variáveis de ambiente)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CLIENT_EMAIL = (process.env.CLIENT_EMAIL || '').trim().toLowerCase();
const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD || '';
// Chave PÚBLICA da API DataJud, publicada pelo próprio CNJ em datajud-wiki.cnj.jus.br (pode ser sobrescrita por env)
const DATAJUD_KEY = process.env.DATAJUD_API_KEY || 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
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
      papel TEXT NOT NULL DEFAULT 'cliente',
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
  `)
    .then(() => pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS papel TEXT NOT NULL DEFAULT 'cliente'`))
    .then(() => garantirContas())
    .then(() => console.log('Banco pronto: usuarios e casos'))
    .catch(e => { console.error('Falha ao preparar o banco:', e.message); pool = null; });
}

async function garantirContas() {
  const contas = [
    { email: ADMIN_EMAIL, senha: ADMIN_PASSWORD, papel: 'admin' },
    { email: CLIENT_EMAIL, senha: CLIENT_PASSWORD, papel: 'cliente' }
  ];
  for (const c of contas) {
    if (!c.email || !c.senha) {
      console.warn(`Conta ${c.papel}: defina o e-mail e a senha nas variáveis de ambiente.`);
      continue;
    }
    if (c.senha.length < 8) {
      console.error(`Conta ${c.papel} (${c.email}): a senha precisa de ao menos 8 caracteres.`);
      continue;
    }
    const hash = await bcrypt.hash(c.senha, 10);
    await pool.query(
      `INSERT INTO usuarios (email, senha_hash, papel) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, papel = EXCLUDED.papel`,
      [c.email, hash, c.papel]
    );
    console.log(`Conta ${c.papel} pronta: ${c.email}`);
  }
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

/** Com banco ativo, o chat exige login. Sem DATABASE_URL, permanece aberto para testes locais. */
function exigirLoginSeHouverContas(req, res, next) {
  if (!pool) return next();
  return autenticar(req, res, next);
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

PROFUNDIDADE PROFISSIONAL: você atende advogados e produz trabalho de banca de primeira linha. Análises de casos concretos, cláusulas e processos devem ser COMPLETAS: fundamentação artigo por artigo, jurisprudência específica identificada por número (Tema de Repercussão Geral, Tema Repetitivo, Súmula, OJ), silogismo explícito, dupla perspectiva (o que a parte contrária alegará), riscos classificados com justificativa, prazos calculados e próximos passos concretos e numerados. Extensão proporcional à complexidade: pergunta simples = resposta curta; caso concreto = análise integral (800–1500 palavras quando necessário). PROIBIDO entregar generalidades que um leigo escreveria — cada afirmação relevante precisa de base legal ou precedente.
JURISPRUDÊNCIA OBRIGATÓRIA: ao fundamentar qualquer tese relevante, USE a busca na web para localizar e confirmar precedentes atuais e específicos (Temas do STF/STJ, Súmulas do TST, acórdãos recentes do tribunal do caso concreto), citando número e, quando possível, data e órgão julgador. O que não confirmar, marque expressamente como "a confirmar na pesquisa". NUNCA invente julgado.
DADOS DE PROCESSO: quando o contexto trouxer um bloco [CONSULTA OFICIAL DATAJUD/CNJ], trate-o como fonte oficial dos metadados e movimentações daquele processo e construa a análise sobre ele. A ÍNTEGRA dos autos você não tem — para analisar conteúdo de decisões e petições, peça o upload das peças (PDF, foto, Word). Se a consulta ao DataJud tiver falhado, diga isso e não invente andamentos.
FORMATO: use ## para títulos de seção, **negrito** para ênfase e — para listas. JAMAIS use tabelas markdown (linhas com |) — o chat não as renderiza e o texto vira ruído; converta qualquer informação tabular em lista com —. Links: escreva a URL pura, sem colchetes. Alertas de prazo SEMPRE em primeiro lugar. Feche análises concretas com a seção "## Próximos passos" numerada e o lembrete de que a revisão final cabe a advogado inscrito na OAB.`;

const PROMPT_REVISORA = `Você é uma revisora jurídica cega. Você recebe APENAS uma análise/peça jurídica pronta, sem acesso ao raciocínio que a gerou nem ao caso original. Sua função NÃO é verificar jurisprudência (você não tem acesso a fontes) — é auditar LÓGICA e CONSISTÊNCIA INTERNA:
1. Contradições internas (afirma X num parágrafo e não-X noutro; datas/valores que não batem).
2. Saltos lógicos: conclusões que não decorrem das premissas apresentadas.
3. Pedidos/recomendações incoerentes com a fundamentação exposta.
4. Ambiguidades que a parte contrária exploraria.
5. Afirmações categóricas apresentadas sem qualquer fundamento no próprio texto.
NÃO opine sobre a veracidade de precedentes citados — apenas marque se algum é citado sem identificação verificável (sem número de Tema/Súmula).
Responda em português do Brasil, em no máximo 200 palavras: "APROVADA SEM RESSALVAS" ou lista objetiva das falhas encontradas, cada uma em uma linha iniciada por "⚠".`;

// ---------- /api/chat — Claude, o investigador ----------

// ---------- DataJud (CNJ): metadados e movimentações públicas do processo ----------
const UF_TJ = {'01':'tjac','02':'tjal','03':'tjap','04':'tjam','05':'tjba','06':'tjce','07':'tjdft','08':'tjes','09':'tjgo','10':'tjma','11':'tjmt','12':'tjms','13':'tjmg','14':'tjpa','15':'tjpb','16':'tjpr','17':'tjpe','18':'tjpi','19':'tjrj','20':'tjrn','21':'tjrs','22':'tjro','23':'tjrr','24':'tjsc','25':'tjse','26':'tjsp','27':'tjto'};
function aliasTribunal(digitos){
  const j = digitos[13], tr = digitos.slice(14,16);
  if (j === '8') return UF_TJ[tr] || null;
  if (j === '4') return 'trf' + Number(tr);
  if (j === '5') return 'trt' + Number(tr);
  return null;
}
const cacheDataJud = new Map(); // digitos → { quando, resultado } — evita repetir a consulta a cada mensagem
async function consultarDataJud(numeroCNJ){
  const digitos = numeroCNJ.replace(/\D/g, '');
  if (digitos.length !== 20) return { ok: false, motivo: 'numero_invalido' };
  const alias = aliasTribunal(digitos);
  if (!alias) return { ok: false, motivo: 'tribunal_nao_mapeado' };

  // Cache de 10 minutos para consultas bem-sucedidas
  const guardado = cacheDataJud.get(digitos);
  if (guardado && Date.now() - guardado.quando < 600_000) return guardado.resultado;

  // O DataJud público oscila: até 3 tentativas com timeout crescente (8s → 12s → 16s)
  let ultimaFalha = { ok: false, motivo: 'rede' };
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), 8000 + tentativa * 4000);
    try {
      const r = await fetch(`https://api-publica.datajud.cnj.jus.br/api_publica_${alias}/_search`, {
        method: 'POST',
        signal: controle.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'APIKey ' + DATAJUD_KEY },
        body: JSON.stringify({ query: { match: { numeroProcesso: digitos } }, size: 1 })
      });
      if (!r.ok) {
        const corpo = (await r.text()).slice(0, 300);
        console.error(`DataJud HTTP ${r.status} [${alias}] tentativa ${tentativa + 1}:`, corpo);
        ultimaFalha = { ok: false, motivo: 'http_' + r.status, alias, detalhe: corpo };
        if (r.status >= 400 && r.status < 500) break; // 4xx não melhora com retry
        continue; // 5xx: tenta de novo
      }
      const d = await r.json();
      const p = d?.hits?.hits?.[0]?._source;
      if (!p) {
        const resultado = { ok: false, motivo: 'nao_indexado', alias, total: d?.hits?.total?.value ?? 0 };
        cacheDataJud.set(digitos, { quando: Date.now(), resultado }); // não indexado também entra no cache
        return resultado;
      }
      const movs = (p.movimentos || []).slice(-30).map(m => `${(m.dataHora || '').slice(0,10)} — ${m.nome}${(m.complementosTabelados||[]).map(c=>' ('+c.nome+')').join('')}`);
      const resultado = { ok: true, alias, resumo: [
        `Tribunal: ${alias.toUpperCase()} | Classe: ${p.classe?.nome || '?'} | Órgão julgador: ${p.orgaoJulgador?.nome || '?'}`,
        `Ajuizamento: ${(p.dataAjuizamento || '').slice(0,10)} | Grau: ${p.grau || '?'} | Formato: ${p.formato?.nome || '?'}`,
        `Assuntos: ${(p.assuntos || []).map(a => a.nome).join('; ') || '?'}`,
        `Últimas movimentações (${movs.length}):`,
        ...movs
      ].join('\n') };
      cacheDataJud.set(digitos, { quando: Date.now(), resultado });
      return resultado;
    } catch (e) {
      console.error(`DataJud exceção (tentativa ${tentativa + 1}/3):`, e.message);
      ultimaFalha = { ok: false, motivo: e.name === 'AbortError' ? 'timeout' : 'rede', detalhe: e.message };
      // segue para a próxima tentativa
    }
    finally { clearTimeout(timer); }
  }
  return ultimaFalha;
}

// Endpoint de diagnóstico: teste direto no navegador → /api/datajud/NUMERO
app.get('/api/datajud/:numero', limitar, async (req, res) => {
  const r = await consultarDataJud(String(req.params.numero || ''));
  res.json(r.ok ? { ok: true, alias: r.alias, resumo: r.resumo.split('\n').slice(0, 12) } : r);
});

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

function limparBase64(data) {
  let s = String(data || '').trim();
  const i = s.indexOf('base64,');
  if (i !== -1) s = s.slice(i + 7);
  else if (s.includes(',')) s = s.split(',').pop();
  return s.replace(/\s/g, '');
}

function pdfValido(b64) {
  try {
    const head = Buffer.from(b64.slice(0, 48), 'base64');
    return head.slice(0, 5).toString('latin1') === '%PDF-';
  } catch { return false; }
}

/** Sobe arquivo binário na Files API da Anthropic e devolve o file_id. */
async function uploadArquivoAnthropic(buffer, nome, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), nome);
  const r = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_FILES_BETA
    },
    body: form
  });
  const texto = await r.text();
  if (!r.ok) {
    const err = new Error(extrairMsgErroApi(texto) || `Files API HTTP ${r.status}`);
    err.status = r.status;
    err.corpo = texto;
    throw err;
  }
  const meta = JSON.parse(texto);
  if (!meta.id) throw new Error('Files API respondeu sem file_id.');
  return meta.id;
}

/**
 * PDFs grandes demais para base64 na Messages API são trocados por file_id.
 * Mantém o histórico original intacto para fallback OpenAI.
 */
async function historicoParaClaudeComFiles(historico) {
  let usouFile = false;
  const out = [];
  for (const m of historico) {
    if (typeof m.content !== 'object' || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const blocos = [];
    for (const b of m.content) {
      if (b.type === 'document' && b.source?.type === 'base64' && b.source.data) {
        const bytes = Buffer.from(b.source.data, 'base64');
        const mb = bytes.length / 1_048_576;
        if (mb > CLAUDE_INLINE_PDF_MAX_MB) {
          const fileId = await uploadArquivoAnthropic(bytes, b.filename || 'documento.pdf', 'application/pdf');
          usouFile = true;
          blocos.push({
            type: 'document',
            title: b.filename || 'documento.pdf',
            source: { type: 'file', file_id: fileId }
          });
          continue;
        }
        blocos.push({
          type: 'document',
          title: b.filename || undefined,
          source: b.source
        });
        continue;
      }
      blocos.push(b);
    }
    out.push({ role: m.role, content: blocos });
  }
  return { historico: out, usouFile };
}

function extrairMsgErroApi(corpo) {
  try {
    const j = JSON.parse(corpo);
    return j?.error?.message || j?.message || '';
  } catch { return String(corpo || '').slice(0, 300); }
}

function mensagemErroAnthropic(status, corpo) {
  const msg = extrairMsgErroApi(corpo);
  const m = msg.toLowerCase();
  if (m.includes('could not process pdf') || m.includes('invalid pdf') || m.includes('unable to process pdf')) {
    return 'Não consegui processar este PDF no Claude. Causas comuns: senha (e-SAJ/PJe), arquivo corrompido ou escaneamento pesado.';
  }
  if (m.includes('too large') || m.includes('request_too_large') || m.includes('request size') || (m.includes('maximum') && m.includes('page')) || status === 413) {
    return 'O PDF é grande demais ou tem páginas demais para o Claude. Tente um arquivo menor ou divida o documento.';
  }
  if (m.includes('credit') || m.includes('billing') || m.includes('balance') || status === 402) {
    return 'Cota Anthropic esgotada ou cobrança pendente.';
  }
  if (m.includes('rate') || status === 429) return 'Rate limit da Anthropic. Aguarde um minuto.';
  if (m.includes('web search') && (m.includes('not enabled') || m.includes('disabled'))) {
    return 'Busca na web da Anthropic desabilitada na organização.';
  }
  if (status === 401 || m.includes('invalid x-api-key') || m.includes('authentication')) {
    return 'ANTHROPIC_API_KEY inválida ou expirada.';
  }
  if (m.includes('overloaded') || status === 529) return 'Anthropic sobrecarregada.';
  return msg ? `Falha Anthropic: ${msg.slice(0, 200)}` : 'Claude indisponível.';
}

function mensagemErroOpenAI(status, corpo) {
  const msg = extrairMsgErroApi(corpo);
  const m = msg.toLowerCase();
  if (m.includes('pdf') || m.includes('file')) {
    return 'A OpenAI não conseguiu ler este PDF (senha, corrompido ou formato inválido).';
  }
  if (m.includes('insufficient_quota') || m.includes('billing') || m.includes('credit') || status === 402) {
    return 'Cota OpenAI esgotada ou cobrança pendente.';
  }
  if (m.includes('rate') || status === 429) return 'Rate limit da OpenAI. Aguarde um minuto.';
  if (status === 401 || m.includes('invalid api key') || m.includes('authentication')) {
    return 'OPENAI_API_KEY inválida ou expirada.';
  }
  return msg ? `Falha OpenAI: ${msg.slice(0, 200)}` : 'OpenAI indisponível.';
}

/** Converte histórico (formato Claude) para Chat Completions da OpenAI, com PDF/imagem. */
function historicoParaOpenAI(historico) {
  return historico.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    if (!Array.isArray(m.content)) return { role: m.role, content: String(m.content || '') };
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'document' && b.source?.data) {
        parts.push({
          type: 'file',
          file: {
            filename: b.filename || 'documento.pdf',
            file_data: `data:application/pdf;base64,${b.source.data}`
          }
        });
      } else if (b.type === 'image' && b.source?.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` }
        });
      } else if (b.text) {
        parts.push({ type: 'text', text: b.text });
      }
    }
    return { role: m.role, content: parts.length ? parts : '' };
  });
}

/** Histórico só texto (DeepSeek e similares). */
function historicoTexto(historico) {
  return historico.map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content)
        ? m.content.map(c => c.text || (c.type === 'document' ? '[PDF anexado — conteúdo visual não disponível neste provedor]' : c.type === 'image' ? '[imagem anexada]' : '')).filter(Boolean).join('\n')
        : String(m.content || ''))
  }));
}

async function streamOpenAIChat(res, { system, messages, aviso }) {
  const resposta = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 8000,
      temperature: 0.4,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!resposta.ok) {
    const erro = await resposta.text();
    console.error('Erro OpenAI:', resposta.status, erro.slice(0, 800));
    return { ok: false, status: resposta.status, erro };
  }
  if (aviso) res.write(aviso);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of resposta.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const linhas = buffer.split('\n');
    buffer = linhas.pop();
    for (const linha of linhas) {
      if (!linha.startsWith('data: ')) continue;
      const bruto = linha.slice(6).trim();
      if (!bruto || bruto === '[DONE]') continue;
      try {
        const ev = JSON.parse(bruto);
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) res.write(delta);
        if (ev.choices?.[0]?.finish_reason === 'length') {
          res.write('\n\n⏸ **[Análise extensa — atingi o limite desta resposta. Envie "continue" e prossigo do ponto exato.]**');
        }
      } catch { /* linha parcial */ }
    }
  }
  return { ok: true };
}

async function chamarDeepSeek({ system, messages }) {
  const resposta = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 4000,
      temperature: 0.4,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    console.error('Erro DeepSeek:', dados);
    return { ok: false, erro: dados?.error?.message || 'DeepSeek indisponível.' };
  }
  return { ok: true, texto: dados.choices?.[0]?.message?.content?.trim() || '' };
}

// ---------- ORÁCULO: lista de agentes para o seletor do frontend ----------
app.get('/api/agentes', (req, res) => res.json({ agentes: listAgents() }));

app.post('/api/chat', limitar, exigirLoginSeHouverContas, async (req, res) => {
  try {
    const { messages, pdf, turnstileToken } = req.body;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
      return res.status(400).json({ erro: 'Histórico de mensagens inválido.' });
    }

    // ORÁCULO: agente selecionado (dropdown) ou invocado por comando; null = Holmes padrão
    const ultimaTextual = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string');
    const agenteOraculo = resolveAgent(ultimaTextual ? ultimaTextual.content : '', req.body.agentId || null);
    if (agenteOraculo) res.setHeader('X-Oraculo-Agente', encodeURIComponent(agenteOraculo.emoji + ' ' + agenteOraculo.nome));

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    if (!(await verificarTurnstile(turnstileToken, ip))) {
      return res.status(403).json({ erro: 'Verificação anti-robô falhou. Recarregue a página e tente de novo.' });
    }

    const historico = messages.map(m => ({ role: m.role, content: String(m.content).slice(0, 20_000) }));

    // Número CNJ na última mensagem? Consulta oficial ao DataJud e injeta como contexto
    const ultimaMsg = historico[historico.length - 1];
    if (ultimaMsg && ultimaMsg.role === 'user' && typeof ultimaMsg.content === 'string') {
      const achado = ultimaMsg.content.match(/\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/);
      if (achado) {
        const dj = await consultarDataJud(achado[0]);
        if (dj.ok) {
          ultimaMsg.content += `\n\n[CONSULTA OFICIAL DATAJUD/CNJ — processo ${achado[0]}]\n${dj.resumo}\n[Fim da consulta oficial. A íntegra das peças não está disponível por esta via; peça upload se precisar do conteúdo das decisões.]`;
        } else if (escavadorAtivo() && (await consultarEscavador(achado[0])).ok) {
          // ESCAVADOR: fallback pago — o DataJud falhou, mas o Escavador respondeu (resultado vem do cache da chamada acima)
          const esc = await consultarEscavador(achado[0]);
          ultimaMsg.content += `\n\n[CONSULTA VIA ESCAVADOR — processo ${achado[0]} (a consulta oficial DataJud/CNJ falhou: ${dj.motivo}; estes dados vêm da base do Escavador, que coleta diretamente dos tribunais)]\n${esc.resumo}\n[Fim da consulta. A íntegra das peças não está disponível por esta via; para o conteúdo das decisões, peça upload dos PDFs pelo 📎.]`;
        } else {
          const explicacao = dj.motivo === 'nao_indexado'
            ? 'o processo existe no formato correto mas NÃO está indexado na base pública do CNJ (comum em processos recentes, em segredo de justiça ou com indexação atrasada)'
            : `a consulta falhou tecnicamente mesmo após 3 tentativas (motivo: ${dj.motivo})`;
          const notaEscavador = escavadorAtivo() ? ' A consulta de fallback via Escavador também não retornou dados.' : '';
          ultimaMsg.content += `\n\n[Consulta ao DataJud/CNJ para o processo ${achado[0]}: ${explicacao}.${notaEscavador} NÃO invente andamentos. Informe o usuário com essa causa específica e ORIENTE O CAMINHO COMPLETO: mesmo quando a consulta funciona, o DataJud entrega apenas metadados e movimentações — NUNCA a íntegra dos autos. Para análise das decisões e peças (conteúdo real), o usuário deve baixar os PDFs no portal do tribunal (e-SAJ/PJe/eproc, consulta pública ou com login de advogado) e ANEXAR no chat pelo botão 📎 — os documentos são lidos na íntegra. Sugira as peças mais úteis para o caso em discussão (ex.: decisão específica, contrato, edital, certidão de intimação).]`;
        }
      }
    }

    // Anexos (até 5): PDF e imagens vão nativos ao Claude; Word/Excel/CSV são extraídos para texto
    const listaAnexos = Array.isArray(req.body.arquivos) ? req.body.arquivos.slice(0, 5) : ((req.body.arquivo || pdf) ? [req.body.arquivo || pdf] : []);
    const blocosBinarios = [];
    const textosExtraidos = [];
    for (const arquivo of listaAnexos) {
      if (!arquivo || !arquivo.data) continue;
      const nome = String(arquivo.name || 'arquivo').slice(0, 120);
      const ext = nome.toLowerCase().split('.').pop();
      const dataB64 = limparBase64(arquivo.data);
      const tamanhoMB = dataB64.length * 0.75 / 1_048_576;
      // PDF até 100MB: Claude via Files API; OpenAI só até ~45MB no fallback
      const teto = ext === 'pdf' ? 100 : (['png','jpg','jpeg','webp','gif'].includes(ext) ? 5 : 15);
      if (tamanhoMB > teto) {
        return res.status(400).json({ erro: `"${nome}" tem ${tamanhoMB.toFixed(1)}MB e excede o limite de ${teto}MB para .${ext}.` });
      }
      const LIMITE_TEXTO = 150_000;
      const visionOk = Boolean(ANTHROPIC_KEY || OPENAI_KEY);
      try {
        if (ext === 'pdf' && visionOk) {
          if (!pdfValido(dataB64)) {
            return res.status(400).json({ erro: `"${nome}" não parece um PDF válido (pode estar corrompido ou não ser PDF de verdade).` });
          }
          blocosBinarios.push({ type: 'document', filename: nome, source: { type: 'base64', media_type: 'application/pdf', data: dataB64 } });
        } else if (['png','jpg','jpeg','webp','gif'].includes(ext) && visionOk) {
          const mapa = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' };
          blocosBinarios.push({ type: 'image', source: { type: 'base64', media_type: mapa[ext], data: dataB64 } });
        } else if (ext === 'docx') {
          const r = await mammoth.extractRawText({ buffer: Buffer.from(dataB64, 'base64') });
          let corpo = String(r.value || '').trim().slice(0, LIMITE_TEXTO);
          if (!corpo) return res.status(400).json({ erro: `Não consegui extrair conteúdo de ${nome}.` });
          textosExtraidos.push(`[Documento Word: "${nome}"]\n${corpo}\n[Fim de ${nome}]`);
        } else if (['xlsx','xls','csv'].includes(ext)) {
          const wb = XLSX.read(Buffer.from(dataB64, 'base64'), { type: 'buffer' });
          const partes = wb.SheetNames.slice(0, 15).map(n => '== Aba: ' + n + ' ==\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n]));
          let corpo = partes.join('\n\n').slice(0, LIMITE_TEXTO);
          textosExtraidos.push(`[Planilha (CSV): "${nome}"]\n${corpo}\n[Fim de ${nome}]`);
        } else if (ext === 'txt') {
          textosExtraidos.push(`[Arquivo de texto: "${nome}"]\n${Buffer.from(dataB64, 'base64').toString('utf8').slice(0, LIMITE_TEXTO)}\n[Fim de ${nome}]`);
        } else if (['pdf','png','jpg','jpeg','webp','gif'].includes(ext)) {
          return res.status(400).json({ erro: 'PDF e imagens exigem Claude (ANTHROPIC_API_KEY) ou OpenAI (OPENAI_API_KEY) neste servidor.' });
        } else {
          return res.status(400).json({ erro: `Formato de "${nome}" não suportado. Envie PDF, DOCX, XLSX, XLS, CSV, TXT ou imagem.` });
        }
      } catch (e) {
        console.error('Falha ao processar anexo:', e.message);
        return res.status(400).json({ erro: `Não consegui ler o arquivo ${nome}. Ele pode estar corrompido ou protegido por senha.` });
      }
    }
    if (listaAnexos.length) {
      const ultima = historico[historico.length - 1];
      const textoBase = (ultima && typeof ultima.content === 'string' && ultima.content) || 'Analise os documentos anexados conforme os módulos aplicáveis.';
      const instrucaoImagem = blocosBinarios.some(b => b.type === 'image') ? 'Leia integralmente os documentos nas imagens (OCR), transcrevendo os trechos relevantes antes de analisar. ' : '';
      const textoFinal = (textosExtraidos.length ? textosExtraidos.join('\n\n') + '\n\n' : '') + instrucaoImagem + textoBase;
      ultima.content = blocosBinarios.length ? [...blocosBinarios, { type: 'text', text: textoFinal }] : textoFinal;
    }

    const temPdf = blocosBinarios.some(b => b.type === 'document');
    const systemPrompt = agenteOraculo ? agenteOraculo.system : PROMPT_HOLMES;
    const falhas = [];

    // ---- 1) Claude (principal) ----
    if (ANTHROPIC_KEY) {
      let historicoClaude = historico;
      let usouFilesApi = false;
      let prepOk = true;
      try {
        if (temPdf) {
          const prep = await historicoParaClaudeComFiles(historico);
          historicoClaude = prep.historico;
          usouFilesApi = prep.usouFile;
        }
      } catch (e) {
        prepOk = false;
        console.error('Falha Files API Anthropic:', e.message, e.corpo?.slice?.(0, 400));
        falhas.push(
          'Falha ao enviar o PDF à Anthropic (Files API): ' +
          (mensagemErroAnthropic(e.status || 502, e.corpo || e.message))
        );
      }

      if (prepOk) {
        const payload = {
          model: agenteOraculo ? agenteOraculo.model : 'claude-sonnet-4-6',
          max_tokens: 8000,
          stream: true,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: historicoClaude
        };
        if (!temPdf) {
          payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
        }

        const headersClaude = {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        };
        if (usouFilesApi) headersClaude['anthropic-beta'] = ANTHROPIC_FILES_BETA;

        const resposta = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: headersClaude,
          body: JSON.stringify(payload)
        });

        if (resposta.ok) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('X-Holmes-Provedor', 'claude');

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
                } else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'max_tokens') {
                  res.write('\n\n⏸ **[Análise extensa — atingi o limite desta resposta. Envie "continue" e prossigo do ponto exato.]**');
                } else if (ev.type === 'error') {
                  console.error('Erro no stream Anthropic:', ev.error?.message);
                  res.write('\n\n' + mensagemErroAnthropic(502, JSON.stringify(ev)));
                }
              } catch { /* linha parcial */ }
            }
          }
          return res.end();
        }

        const erroClaude = await resposta.text();
        console.error('Erro Anthropic (vai para fallback):', resposta.status, erroClaude.slice(0, 800));
        falhas.push(mensagemErroAnthropic(resposta.status, erroClaude));
      }
    }

    // ---- 2) OpenAI (fallback com PDF nativo; limite ~50MB) ----
    const pdfMbMax = blocosBinarios
      .filter(b => b.type === 'document' && b.source?.data)
      .reduce((m, b) => Math.max(m, b.source.data.length * 0.75 / 1_048_576), 0);
    if (OPENAI_KEY && pdfMbMax > OPENAI_PDF_MAX_MB) {
      falhas.push(`PDF com ${pdfMbMax.toFixed(1)}MB ultrapassa o limite da OpenAI (~${OPENAI_PDF_MAX_MB}MB).`);
    } else if (OPENAI_KEY) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Holmes-Provedor', 'openai');
      const aviso = falhas.length
        ? '⚙️ [Claude indisponível — continuando com OpenAI]\n\n'
        : '';
      const rOpen = await streamOpenAIChat(res, {
        system: systemPrompt,
        messages: historicoParaOpenAI(historico),
        aviso
      });
      if (rOpen.ok) return res.end();
      falhas.push(mensagemErroOpenAI(rOpen.status, rOpen.erro));
    }

    // ---- 3) DeepSeek (último fallback — só texto) ----
    if (DEEPSEEK_KEY) {
      const jaStreaming = res.getHeader('Content-Type');
      if (!jaStreaming) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      res.setHeader('X-Holmes-Provedor', 'deepseek');
      if (falhas.length || temPdf) {
        res.write(temPdf
          ? '⚙️ [Fallback DeepSeek — PDF não é lido nativamente aqui; analiso com base no texto/contexto disponível]\n\n'
          : '⚙️ [Fallback DeepSeek]\n\n');
      }
      const rDs = await chamarDeepSeek({ system: systemPrompt, messages: historicoTexto(historico) });
      if (rDs.ok) return res.end(rDs.texto);
      falhas.push(rDs.erro || 'DeepSeek indisponível.');
    }

    if (!res.headersSent) {
      return res.status(502).json({
        erro: falhas.length
          ? falhas.join(' → ')
          : 'Nenhuma chave de IA configurada (ANTHROPIC_API_KEY, OPENAI_API_KEY ou DEEPSEEK_API_KEY).'
      });
    }
    return res.end('\n\n' + (falhas.join(' → ') || 'Nenhum investigador disponível.'));
  } catch (e) {
    console.error(e);
    try {
      if (!res.headersSent) return res.status(500).json({ erro: 'A investigação foi interrompida por uma falha. Envie novamente.' });
      res.end('\n\n[A investigação foi interrompida por uma falha. Envie novamente.]');
    } catch {}
  }
});

// ---------- /api/contracheck — DeepSeek, a revisora cega ----------
app.post('/api/contracheck', limitar, exigirLoginSeHouverContas, async (req, res) => {
  try {
    // Revisão cruzada exige DeepSeek + outro provedor (Claude ou OpenAI)
    if (!DEEPSEEK_KEY || !(ANTHROPIC_KEY || OPENAI_KEY)) return res.json({ disponivel: false });
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


// ---------- Contas e casos salvos (cadastro público fechado — só admin + 1 cliente via env) ----------
app.post('/api/registro', limitar, async (_req, res) => {
  res.status(403).json({ erro: 'Cadastro fechado. Use a conta fornecida pelo administrador.' });
});

app.post('/api/login', limitar, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ erro: 'Contas desativadas neste servidor.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    const r = await pool.query('SELECT id, senha_hash, papel FROM usuarios WHERE email = $1', [email]);
    if (!r.rows[0] || !(await bcrypt.compare(senha, r.rows[0].senha_hash))) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
    }
    const { id, papel } = r.rows[0];
    const token = jwt.sign({ id, email, papel }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email, papel });
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

app.get('/api/saude', (_req, res) => {
  const cadeia = [
    ANTHROPIC_KEY && 'claude',
    OPENAI_KEY && 'openai',
    DEEPSEEK_KEY && 'deepseek'
  ].filter(Boolean);
  res.json({
    ok: true,
    investigador: cadeia[0] || false,
    cadeia,
    openaiModel: OPENAI_KEY ? OPENAI_MODEL : null,
    revisora: Boolean(DEEPSEEK_KEY && (ANTHROPIC_KEY || OPENAI_KEY)),
    buscaWeb: Boolean(ANTHROPIC_KEY),
    pdf: Boolean(ANTHROPIC_KEY || OPENAI_KEY),
    turnstileSiteKey: TURNSTILE_SITE_KEY || null,
    contas: Boolean(pool),
    datajud: true,
    multiAnexos: 5
  });
});

app.listen(PORT, () => console.log(`Agente Holmes investigando na porta ${PORT}`));
