// ============================================================
// ESCAVADOR — fallback e complemento do DataJud (módulo aditivo)
// Consulta processos por número CNJ na API v2 do Escavador.
// SÓ ATIVA se a variável de ambiente ESCAVADOR_TOKEN existir.
// Sem o token, o site funciona exatamente como antes.
//
// Token: painel em https://api.escavador.com (Bearer).
// Docs:  https://api.escavador.com/v1/docs/ (v1 e v2)
// Custo: cobrado por créditos por consulta — o cache abaixo evita
// consultas repetidas do mesmo processo na mesma janela.
// ============================================================

const ESCAVADOR_TOKEN = process.env.ESCAVADOR_TOKEN || '';
const ATIVO = Boolean(ESCAVADOR_TOKEN);

const cacheEscavador = new Map(); // digitos → { quando, resultado }
const CACHE_MS = 30 * 60 * 1000;  // 30 min: consulta paga, cache mais longo que o do DataJud

function formatarCNJ(digitos) {
  // 20 dígitos → NNNNNNN-DD.AAAA.J.TR.OOOO
  return `${digitos.slice(0,7)}-${digitos.slice(7,9)}.${digitos.slice(9,13)}.${digitos.slice(13,14)}.${digitos.slice(14,16)}.${digitos.slice(16,20)}`;
}

async function consultarEscavador(numeroCNJ) {
  if (!ATIVO) return { ok: false, motivo: 'sem_token' };
  const digitos = String(numeroCNJ).replace(/\D/g, '');
  if (digitos.length !== 20) return { ok: false, motivo: 'numero_invalido' };

  const guardado = cacheEscavador.get(digitos);
  if (guardado && Date.now() - guardado.quando < CACHE_MS) return guardado.resultado;

  const cnj = formatarCNJ(digitos);
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 20000);
  try {
    const r = await fetch(`https://api.escavador.com/api/v2/processos/numero_cnj/${encodeURIComponent(cnj)}`, {
      method: 'GET',
      signal: controle.signal,
      headers: { 'Authorization': 'Bearer ' + ESCAVADOR_TOKEN, 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!r.ok) {
      const corpo = (await r.text()).slice(0, 300);
      console.error(`Escavador HTTP ${r.status}:`, corpo);
      return { ok: false, motivo: 'http_' + r.status, detalhe: corpo };
    }
    const d = await r.json();

    // Parse defensivo: a estrutura pode variar entre versões da API.
    const linhas = [];
    const capa = d?.capa || d;
    if (capa?.classe) linhas.push(`Classe: ${capa.classe}`);
    if (capa?.assunto || capa?.assuntos) linhas.push(`Assunto(s): ${capa.assunto || (Array.isArray(capa.assuntos) ? capa.assuntos.join('; ') : '')}`);
    if (capa?.orgao_julgador || capa?.orgaoJulgador) linhas.push(`Órgão julgador: ${capa.orgao_julgador || capa.orgaoJulgador}`);
    if (capa?.data_distribuicao || capa?.data_inicio) linhas.push(`Distribuição: ${capa.data_distribuicao || capa.data_inicio}`);
    if (capa?.valor_causa?.valor_formatado || capa?.valor_causa) linhas.push(`Valor da causa: ${capa.valor_causa?.valor_formatado || capa.valor_causa}`);

    const fontes = Array.isArray(d?.fontes) ? d.fontes : [];
    for (const f of fontes.slice(0, 2)) {
      if (f?.nome || f?.sigla) linhas.push(`Fonte: ${f.nome || f.sigla}${f.grau ? ' (grau ' + f.grau + ')' : ''}`);
      const partes = Array.isArray(f?.envolvidos) ? f.envolvidos : [];
      const nomesPartes = partes.slice(0, 8).map(p => `${p.tipo || p.polo || '?'}: ${p.nome || '?'}`);
      if (nomesPartes.length) linhas.push('Partes: ' + nomesPartes.join(' | '));
    }

    // Movimentações: tenta os formatos conhecidos
    const movs = [];
    const listaMovs = d?.movimentacoes || d?.movimentos || fontes.flatMap(f => f?.movimentacoes || []) || [];
    for (const m of listaMovs.slice(0, 30)) {
      const data = (m?.data || m?.dataHora || '').toString().slice(0, 10);
      const texto = (m?.conteudo || m?.descricao || m?.nome || '').toString().slice(0, 200);
      if (texto) movs.push(`${data} — ${texto}`);
    }
    if (movs.length) { linhas.push(`Últimas movimentações (${movs.length}):`); linhas.push(...movs); }

    if (!linhas.length) return { ok: false, motivo: 'sem_dados', detalhe: JSON.stringify(d).slice(0, 200) };

    const resultado = { ok: true, resumo: linhas.join('\n') };
    cacheEscavador.set(digitos, { quando: Date.now(), resultado });
    return resultado;
  } catch (e) {
    console.error('Escavador exceção:', e.message);
    return { ok: false, motivo: e.name === 'AbortError' ? 'timeout' : 'rede', detalhe: e.message };
  } finally { clearTimeout(timer); }
}

module.exports = { consultarEscavador, escavadorAtivo: () => ATIVO };
