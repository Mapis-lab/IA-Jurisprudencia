
import http from 'node:http';
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';

const MODELO = 'gemini-2.5-flash';

const DOMINIOS = [
  'corteconstitucional.gov.co',
  'consejodeestado.gov.co',
  'cortesuprema.gov.co',
  'ramajudicial.gov.co'
];

function obtenerCliente() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar GEMINI_API_KEY en Render.');
  }
  return new GoogleGenAI({ apiKey });
}

function extraerJSON(texto) {
  if (!texto) throw new Error('La IA no devolvió contenido.');

  const limpio = texto
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');

  if (inicio === -1 || fin === -1) {
    throw new Error('La IA no devolvió un JSON válido.');
  }

  return JSON.parse(limpio.slice(inicio, fin + 1));
}

function esDominioOficial(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return DOMINIOS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ETAPA 1: analizar y resumir el caso.
async function ficha(caso) {
  const ai = obtenerCliente();

  const respuesta = await ai.models.generateContent({
    model: MODELO,
    contents: `Eres un asistente jurídico colombiano.
Lee el CASO y responde SOLO un JSON válido con:
hechos[], problema (problema jurídico), conceptos[],
sinonimos[{termino,equivalentes[]}],
polisemia[{termino,sentidos}], normas[], pruebas[],
argumentos[], area (rama del derecho),
consultas[4 búsquedas cortas para relatorías],
resumen_busqueda (máximo 150 palabras con lo esencial para buscar jurisprudencia).

No inventes datos que no estén en el caso.
No escribas explicaciones fuera del JSON.

CASO:
${caso.slice(0, 120000)}`,
    config: {
      maxOutputTokens: 2500,
      temperature: 0.2
    }
  });

  return extraerJSON(respuesta.text);
}

// ETAPA 2: búsqueda web de jurisprudencia.
async function buscar(f) {
  const ai = obtenerCliente();

  const prompt = `Busca jurisprudencia colombiana REAL relacionada con este caso.

Debes buscar en fuentes oficiales de las altas cortes colombianas.
Prioriza estos dominios:
${DOMINIOS.join(', ')}

Busca por significado jurídico, hechos, problemas y normas,
no solamente por palabras idénticas.

FICHA DEL CASO:
${JSON.stringify({
  problema: f.problema,
  area: f.area,
  conceptos: f.conceptos,
  normas: f.normas,
  consultas: f.consultas,
  resumen: f.resumen_busqueda
})}

Devuelve SOLO un JSON válido con esta estructura:
{
  "resultados": [
    {
      "nombre": "Sentencia T-123 de 2020",
      "corte": "Corte Constitucional",
      "anio": 2020,
      "fecha": "Fecha de la sentencia",
      "radicado": "Número de radicado",
      "ponente": "Nombre del magistrado",
      "temas": [],
      "resumen": "Resumen de 3 a 4 frases",
      "por_que": "Explicación de la relación con el caso",
      "similitud": {
        "hechos": 0,
        "problema": 0,
        "normas": 0,
        "pruebas": 0,
        "argumentos": 0,
        "fallo": 0
      },
      "fuente_titulo": "Título de la fuente",
      "url": "URL oficial exacta"
    }
  ]
}

REGLAS OBLIGATORIAS:
- Devuelve entre 3 y 8 sentencias si encuentras suficientes.
- No inventes sentencias, radicados, ponentes, fechas ni enlaces.
- Cada URL debe pertenecer a uno de los dominios oficiales indicados.
- Usa enlaces de documentos o fichas oficiales que hayas encontrado.
- Si un dato no aparece, escribe "No consta".
- Los porcentajes de similitud son estimaciones razonadas, no mediciones oficiales.
- Si no encuentras sentencias verificables, devuelve resultados vacío.
- No confundas noticias o artículos con sentencias judiciales.`;

  const respuesta = await ai.models.generateContent({
    model: MODELO,
    contents: prompt,
    config: {
      maxOutputTokens: 6000,
      temperature: 0.2,
      tools: [{ googleSearch: {} }]
    }
  });

  const datos = extraerJSON(respuesta.text);

  // Comprobar que los enlaces sean oficiales y aparezcan
  // entre las fuentes devueltas por la búsqueda de Google.
  const candidatos = respuesta.candidates || [];
  const metadatos = candidatos[0]?.groundingMetadata;
  const fuentes = metadatos?.groundingChunks || [];

  const urlsEncontradas = new Set(
    fuentes
      .map(fuente => fuente.web?.uri)
      .filter(url => url && esDominioOficial(url))
  );

  const resultados = (datos.resultados || [])
    .filter(item =>
      item.url &&
      esDominioOficial(item.url) &&
      urlsEncontradas.has(item.url)
    )
    .slice(0, 8);

  return { resultados };
}

// SERVIDOR
http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';

    try {
      for await (const c of req) {
        body += c;
        if (body.length > 15_000_000) {
          throw new Error('El documento es demasiado grande.');
        }
      }

      const { caso } = JSON.parse(body);

      if (!caso || caso.trim().length < 30) {
        throw new Error('Escribe un caso más detallado o sube un documento.');
      }

      const f = await ficha(caso);
      const { resultados } = await buscar(f);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8'
      });

      res.end(JSON.stringify({
        ...f,
        resultados: resultados || []
      }));

    } catch (e) {
      console.error(e);

      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8'
      });

      res.end(JSON.stringify({ error: e.message }));
    }

    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8'
  });

  res.end(
    fs.readFileSync(new URL('./public/index.html', import.meta.url))
  );

}).listen(process.env.PORT || 3000, () => {
  console.log('Servidor activo');
});
