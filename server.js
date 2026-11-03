import http from 'node:http';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // usa ANTHROPIC_API_KEY
const BARATO = 'claude-haiku-5-5';   // lee y comprime el documento
const BUSCADOR = 'claude-sonnet-5-5'; // busca en sitios oficiales
const DOMINIOS = ['corteconstitucional.gov.co','consejodeestado.gov.co','cortesuprema.gov.co','ramajudicial.gov.co'];

const json = t => { const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.slice(a, b + 1)); };
const texto = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('');

// ETAPA 1 (barata): el documento completo se resume en una "ficha" corta.
async function ficha(caso) {
  const r = await client.messages.create({
    model: BARATO, max_tokens: 2500,
    messages: [{ role: 'user', content: `Eres asistente jurídico colombiano. Lee el CASO y responde SOLO un JSON con: hechos[], problema (problema jurídico), conceptos[], sinonimos[{termino,equivalentes[]}], polisemia[{termino,sentidos}], normas[], pruebas[], argumentos[], area (rama del derecho), consultas[4 búsquedas cortas para relatorías], resumen_busqueda (máx. 150 palabras con lo esencial para buscar jurisprudencia). No inventes datos que no estén en el caso.\n\nCASO:\n${caso.slice(0, 120000)}` }]
  });
  return json(texto(r));
}

// ETAPA 2: búsqueda real con herramienta web restringida a sitios oficiales. Recibe solo la ficha.
async function buscar(f) {
  const messages = [{ role: 'user', content: `Busca en los sitios oficiales de las altas cortes colombianas jurisprudencia relacionada con este caso (por significado, no solo por palabras idénticas).\nFICHA: ${JSON.stringify({ problema: f.problema, area: f.area, conceptos: f.conceptos, normas: f.normas, resumen: f.resumen_busqueda })}\n\nResponde SOLO un JSON {"resultados":[...]} con 3 a 8 sentencias REALES que hayas encontrado, cada una: nombre (ej. "Sentencia T-123 de 2020"), corte, anio, fecha, radicado, ponente, temas[], resumen (3-4 frases), por_que (por qué se relaciona, 2-3 frases), similitud {hechos,problema,normas,pruebas,argumentos,fallo} con enteros 0-100, fuente_titulo, url (la URL exacta donde la leíste). REGLAS: nunca inventes sentencias, radicados, ponentes ni URLs; si un dato no aparece en la fuente escribe "No consta"; si no encuentras nada relevante devuelve resultados vacío.` }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8, allowed_domains: DOMINIOS }];
  for (let i = 0; i < 4; i++) {
    const r = await client.messages.create({ model: BUSCADOR, max_tokens: 6000, tools, messages });
    if (r.stop_reason !== 'pause_turn') return json(texto(r));
    messages.push({ role: 'assistant', content: r.content });
  }
  throw new Error('La búsqueda tardó demasiado');
}

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = ''; for await (const c of req) body += c;
    try {
      const { caso } = JSON.parse(body);
      if (!caso || caso.trim().length < 30) throw new Error('Escribe un caso más detallado o sube un documento.');
      const f = await ficha(caso);
      const { resultados } = await buscar(f);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...f, resultados: resultados || [] }));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(new URL('./public/index.html', import.meta.url)));
}).listen(process.env.PORT || 3000, () => console.log('Servidor activo'));
