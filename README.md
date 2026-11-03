# Búsqueda de Jurisprudencia (versión funcional)
1. Instala Node.js 18+ (nodejs.org).
2. En esta carpeta: `npm install`
3. Clave de API: console.anthropic.com → API Keys.
   - Mac/Linux: `export ANTHROPIC_API_KEY=tu_clave`
   - Windows (PowerShell): `$env:ANTHROPIC_API_KEY="tu_clave"`
4. `npm start` y abre http://localhost:3000

Ahorro de tokens: el PDF se convierte a texto en tu navegador; un modelo barato (Haiku) lo resume en una "ficha"; solo la ficha va a la búsqueda web (Sonnet), limitada a sitios oficiales de las altas cortes.
