// Los adaptadores que solo hablan con un sistema externo (Gemini, Qdrant, Redis) quedan fuera
// del gate unitario: lo que probarían es la respuesta de ese sistema, no la nuestra; los cubre
// el smoke contra el stack real. La lógica con reglas que vivía dentro de ellos se extrajo a
// módulos puros (`gemini-errors`, `buildPath`, `hashVector`) que sí entran al gate.
module.exports = require('../../jest.preset.cjs')(__dirname, {
  extraIgnore: [
    '!src/infrastructure/llm/gemini-provider.ts',
    '!src/infrastructure/redis/**',
    '!src/infrastructure/knowledge/**', // lectura de archivos y el bootstrap de arranque, como los *-bootstrap del resto
  ],
});
