# Agente de IA · documentación

La Parte 2 de la prueba: un asistente con RAG sobre la base de conocimiento y herramientas de solo
lectura sobre los microservicios.

| Documento | Qué contiene |
|---|---|
| [`agent-design.md`](agent-design.md) | Qué hace, qué no puede hacer, puertos y adaptadores, el recorrido de una pregunta y la escalera de degradación |
| [`rag-pipeline.md`](rag-pipeline.md) | De un markdown a un pasaje citado: troceado, embeddings, ingesta idempotente y el ACL dentro de la consulta |
| [`prompt-engineering.md`](prompt-engineering.md) | Qué dice el prompt y por qué cada instrucción está ahí; el canario; cómo cambiarlo sin empeorar las cosas |
| [`evaluation.md`](evaluation.md) | El golden set, qué se mide y qué no, y los tres defectos reales que encontró |
| [`reports/`](reports/) | Reportes generados por `npm run eval`, con fecha, proveedor y modelo |

## Pruébalo en un minuto

El asistente **funciona sin clave de API**: sin `GEMINI_API_KEY` arranca con un proveedor mock
determinista que recupera de verdad, cita de verdad y llama a las herramientas de verdad. La
interfaz lo dice con claridad para que nadie confunda la demostración con el sistema real.

```bash
npm run up:dev

TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@toka.local","password":"Admin123!demo"}' | jq -r .accessToken)

# 1. Qué modo está activo y qué herramientas ve este usuario
curl -s -H "authorization: Bearer $TOKEN" \
  http://localhost:8080/api/v1/agent/capabilities | jq '{provider, model, tools: [.tools[].name]}'

# 2. Una pregunta de política: responde citando los pasajes
curl -s -X POST http://localhost:8080/api/v1/agent/query \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"¿Quién puede suspender a un usuario?"}' \
  | jq '{answer, citations: [.citations[] | "\(.title) › \(.section)"], mode, latency, usage}'

# 3. Un dato en vivo: no está en la base de conocimiento, va a buscarlo con TU token
curl -s -X POST http://localhost:8080/api/v1/agent/query \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"¿Cuántos usuarios activos hay?"}' \
  | jq '{answer, tools: [.toolCalls[] | {name, ok}]}'
```

Y la comprobación que más dice del diseño — el mismo sistema, otra persona:

```bash
VIEWER=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"viewer@toka.local","password":"Viewer123!demo"}' | jq -r .accessToken)

# El viewer no tiene audit:read: ni se le ofrece la herramienta de auditoría…
curl -s -H "authorization: Bearer $VIEWER" \
  http://localhost:8080/api/v1/agent/capabilities | jq '[.tools[].name]'

# …ni recupera los pasajes del documento de auditoría.
curl -s -X POST http://localhost:8080/api/v1/agent/query \
  -H "authorization: Bearer $VIEWER" -H 'content-type: application/json' \
  -d '{"question":"¿Cómo consulto los intentos de acceso fallidos?"}' \
  | jq '[.citations[].docId]'
```

En la interfaz, lo mismo está en **<http://localhost:8080/assistant>**.

## Evaluar

```bash
npm run eval                      # escribe docs/ai/reports/<proveedor>.md
```

Los detalles, en [`evaluation.md`](evaluation.md).
