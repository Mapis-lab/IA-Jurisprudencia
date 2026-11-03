import http from 'node:http';
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';

// ==========================================
// CONFIGURACIÓN
// ==========================================

const MODELO = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const DOMINIOS = [
  'corteconstitucional.gov.co',
  'consejodeestado.gov.co',
  'cortesuprema.gov.co',
  'ramajudicial.gov.co'
];

// ==========================================
// CONEXIÓN CON GEMINI
// ==========================================

function obtenerCliente() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Falta configurar GEMINI_API_KEY en Render.'
    );
  }

  return new GoogleGenAI({ apiKey });
}

// ==========================================
// SISTEMA DE REINTENTOS AUTOMÁTICOS
// ==========================================

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ejecutarConReintentos(
  operacion,
  maxIntentos = 4
) {
  let ultimoError;

  for (let intento = 0; intento < maxIntentos; intento++) {
    try {
      return await operacion();

    } catch (error) {
      ultimoError = error;

      const estado = Number(
        error.status ||
        error.statusCode ||
        error.code
      );

      const mensaje = String(
        error.message || ''
      ).toLowerCase();

      const reintentable =
        [408, 429, 500, 502, 503, 504].includes(estado) ||
        mensaje.includes('high demand') ||
        mensaje.includes('overloaded') ||
        mensaje.includes('temporarily unavailable');

      if (!reintentable || intento === maxIntentos - 1) {
        throw error;
      }

      const demora = 2000 * Math.pow(2, intento);

      console.warn(
        `Gemini no disponible. Intento ${intento + 1} de ${maxIntentos}.`
      );

      await esperar(demora);
    }
  }

  throw ultimoError;
}

// ==========================================
// PROCESAMIENTO DE JSON
// ==========================================

function extraerJSON(texto) {
  if (!texto) {
    throw new Error('La IA no devolvió contenido.');
  }

  const limpio = texto
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');

  if (inicio === -1 || fin === -1) {
    throw new Error('La IA no devolvió un JSON válido.');
  }

  try {
    return JSON.parse(
      limpio.slice(inicio, fin + 1)
    );
  } catch {
    throw new Error(
      'La IA devolvió información con formato JSON incorrecto.'
    );
  }
}

// ==========================================
// VALIDACIÓN DE FUENTES OFICIALES
// ==========================================

function esDominioOficial(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return DOMINIOS.some(d =>
      host === d || host.endsWith('.' + d)
    );

  } catch {
    return false;
  }
}

function obtenerFuentes(interaccion) {
  const fuentes = [];

  for (const paso of interaccion.steps || []) {
    if (paso.type !== 'model_output') continue;

    for (const bloque of paso.content || []) {
      if (bloque.type !== 'text') continue;

      for (const anotacion of bloque.annotations || []) {
        if (
          anotacion.type === 'url_citation' &&
          anotacion.url &&
          esDominioOficial(anotacion.url)
        ) {
          fuentes.push({
            url: anotacion.url,
            titulo: anotacion.title || 'Fuente oficial'
          });
        }
      }
    }
  }

  return fuentes;
}

// ==========================================
// ETAPA 1: ANÁLISIS DEL CASO
// ==========================================

async function ficha(caso) {
  const ai = obtenerCliente();

  const respuesta = await ejecutarConReintentos(() =>
    ai.interactions.create({
      model: MODELO,
      store: false,

      input: `Eres un asistente jurídico colombiano.

Lee el CASO y responde SOLO un JSON válido con:

hechos[],
problema (problema jurídico),
conceptos[],
sinonimos[{termino,equivalentes[]}],
polisemia[{termino,sentidos}],
normas[],
pruebas[],
argumentos[],
area (rama del derecho),
consultas[4 búsquedas cortas para relatorías],
resumen_busqueda (máximo 150 palabras con lo esencial para buscar jurisprudencia).

No inventes datos que no estén en el caso.
No escribas explicaciones fuera del JSON.

CASO:
${caso.slice(0, 120000)}`
    })
  );

  return extraerJSON(respuesta.output_text);
}

// ==========================================
// ETAPA 2: BÚSQUEDA DE JURISPRUDENCIA
// ==========================================

async function buscar(f) {
  const ai = obtenerCliente();

  const prompt = `Busca jurisprudencia colombiana REAL relacionada con este caso.

Busca por significado jurídico, hechos, problemas y normas,
no solamente por palabras idénticas.

Prioriza exclusivamente fuentes oficiales de estas altas cortes:
${DOMINIOS.join(', ')}

FICHA DEL CASO:
${JSON.stringify({
  problema: f.problema,
  area: f.area,
  conceptos: f.conceptos,
  normas: f.normas,
  consultas: f.consultas,
  resumen: f.resumen_busqueda
})}

Responde SOLO un JSON válido con esta estructura:

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

REGLAS:
- Devuelve entre 3 y 8 sentencias si encuentras suficientes.
- No inventes sentencias, radicados, ponentes, fechas ni enlaces.
- Cada sentencia debe tener una fuente oficial verificable.
- Si un dato no aparece, escribe "No consta".
- Los porcentajes de similitud son estimaciones razonadas.
- No confundas noticias o artículos con sentencias.
- Si no encuentras sentencias verificables, devuelve resultados vacío.`;

  const respuesta = await ejecutarConReintentos(() =>
    ai.interactions.create({
      model: MODELO,
      store: false,
      input: prompt,
      tools: [{ type: 'google_search' }]
    })
  );

  const datos = extraerJSON(respuesta.output_text);

  const fuentes = obtenerFuentes(respuesta);

  const urlsOficiales = new Set(
    fuentes.map(f => f.url)
  );

  const resultados = (datos.resultados || [])
    .filter(item =>
      item.url &&
      esDominioOficial(item.url) &&
      urlsOficiales.has(item.url)
    )
    .slice(0, 8);

  return { resultados };
}

// ==========================================
// SERVIDOR PRINCIPAL
// ==========================================

http.createServer(async (req, res) => {

  // ANALIZAR CASO
  if (req.method === 'POST' && req.url === '/api/analyze') {

    let body = '';

    try {

      for await (const c of req) {
        body += c;

        if (body.length > 15_000_000) {
          throw new Error(
            'El documento es demasiado grande.'
          );
        }
      }

      const { caso } = JSON.parse(body);

      if (!caso || caso.trim().length < 30) {
        throw new Error(
          'Escribe un caso más detallado o sube un documento.'
        );
      }

      console.log('Iniciando análisis jurídico...');

      // ETAPA 1
      const f = await ficha(caso);

      console.log('Ficha jurídica completada.');

      // ETAPA 2
      const { resultados } = await buscar(f);

      console.log('Búsqueda jurisprudencial completada.');

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8'
      });

      res.end(JSON.stringify({
        ...f,
        resultados: resultados || []
      }));

    } catch (e) {

      console.error('ERROR EN EL ANÁLISIS:', e);

      const estado = Number(
        e.status ||
        e.statusCode ||
        e.code
      );

      const mensaje = String(e.message || '');

      const errorTemporal =
        [408, 429, 500, 502, 503, 504].includes(estado) ||
        /high demand|overloaded|temporarily unavailable/i.test(mensaje);

      const codigoHTTP = errorTemporal
        ? (estado >= 400 && estado <= 599 ? estado : 503)
        : 500;

      res.writeHead(codigoHTTP, {
        'Content-Type': 'application/json; charset=utf-8'
      });

      res.end(JSON.stringify({
        error: errorTemporal
          ? 'El servicio de inteligencia artificial está temporalmente ocupado. Intenta nuevamente en unos momentos.'
          : mensaje
      }));
    }

    return;
  }

  // MOSTRAR PÁGINA PRINCIPAL
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8'
  });

  try {

    const archivo = fs.readFileSync(
      new URL('./public/index.html', import.meta.url)
    );

    res.end(archivo);

  } catch (error) {

    console.error(error);

    res.writeHead(500);

    res.end('No se pudo cargar la aplicación.');
  }

}).listen(process.env.PORT || 3000, () => {

  console.log('================================');
  console.log(' SERVIDOR JURISPRUDENCIA ACTIVO');
  console.log(' Modelo:', MODELO);
  console.log('================================');

});
