# Pipeline de RAG

> De un archivo markdown a un pasaje citado en una respuesta, y por qué cada decisión.

## 1. La base de conocimiento son archivos del repositorio

Cinco documentos en `services/ai-agent-service/knowledge-base/`, no filas en una base de datos.
Así un cambio de política se revisa en un *pull request*, queda en el historial y se despliega con
el resto del código; y quien evalúa puede leer **exactamente** lo que el agente sabe sin levantar
nada.

El front-matter declara el permiso necesario para ver el documento:

```markdown
---
title: Auditoría de accesos y cambios
requiredPermission: audit:read
---
```

| Documento | Permiso | Por qué |
|---|---|---|
| `01-politica-de-accesos` | — | Público: todo el mundo debe poder preguntar quién puede hacer qué |
| `02-ciclo-de-vida-de-usuarios` | — | Público |
| `03-auditoria` | `audit:read` | Describe cómo consultar la auditoría; el `viewer` no debe verlo |
| `04-preguntas-frecuentes` | — | Público |
| `05-runbook-operacion` | `users:write` | Procedimientos de administración |

## 2. Troceado: la unidad es la sección, no el número de caracteres

Se corta por encabezados **H2/H3**, no cada N caracteres. La razón es la citación: un apartado de
una política es una idea completa, y **una cita que apunta a media frase no se puede verificar**.
Solo cuando una sección pasa de 1000 caracteres se parte en ventanas con 150 de traslape, y se
parte por párrafo antes que por carácter.

El traslape existe para que una frase que cae justo en la frontera siga siendo recuperable desde
cualquiera de los dos lados.

**El encabezado viaja dentro del texto que se embebe**: «Quién puede suspender usuarios» y el
cuerpo de la sección se buscan mejor juntos que por separado. El identificador del chunk es
`${docId}#${índice}`, estable mientras no cambie la estructura del documento.

Resultado actual: **32 pasajes** de 5 documentos.

## 3. Embeddings e ingesta idempotente

`gemini-embedding-001` a **768 dimensiones**, con `taskType` distinto para documento y consulta —
mezclarlos degrada la recuperación en silencio. Los vectores se normalizan porque el modelo no los
entrega normalizados por debajo de 3072 dimensiones.

La ingesta corre al arrancar, **sin bloquear el arranque HTTP**, y es idempotente: se comparan
hashes y solo se embebe lo que cambió. Reiniciar el contenedor cuesta cero llamadas al proveedor,
que es justo lo que se quiere con una cuota gratuita.

> **El hash cubre el modelo, no solo el texto.** Es la parte que no es obvia y costó un fallo
> real. Un vector solo significa algo dentro del espacio del modelo que lo produjo: dos modelos de
> 768 dimensiones —`gemini-embedding-001` y el proveedor mock— generan espacios **incompatibles**.
> Qdrant los acepta sin quejarse, porque la dimensión encaja, y devuelve ruido: puntajes de 0.01 a
> 0.04 y un orden sin sentido. Ni un error, ni una excepción, solo un asistente que contesta «no
> lo sé» a todo. Con el modelo dentro del hash, cambiarlo invalida el índice y se reconstruye solo.
> Lo detectó el golden set al correr en modo mock sobre un índice creado con Gemini.

Los lotes son de 20: una llamada por chunk gasta cuota en saludos.

## 4. Recuperación con el ACL dentro de la consulta

```
filter: { should: [
  { is_null: { key: 'requiredPermission' } },                      // público
  { key: 'requiredPermission', match: { any: [...permisos] } },    // o autorizado
]}
```

Dos ramas en un `should`, no una lista única: `match.any` de Qdrant acepta cadenas o enteros, y
meter `null` dentro devuelve un **400** (`data did not match any variant of untagged enum
MatchInterface`), lo que convertía toda consulta del agente en un 503. Está cubierto por un test.

Con la lista de permisos vacía queda solo la rama `is_null`: alguien sin permisos ve únicamente lo
público, que es exactamente lo que debe pasar.

**Por qué el filtro va en la consulta y no después:** un pasaje que el usuario no puede ver nunca
llega a estar en memoria del proceso, así que no puede acabar en un log, en un mensaje de error ni
en el prompt por un descuido posterior.

## 5. El umbral de relevancia pertenece al modelo

`AI_RETRIEVAL_LIMIT=5` pasajes como máximo, por encima de `minScore`.

Y `minScore` **no es configuración del sistema: es una propiedad del espacio del modelo**, así que
lo declara el `EmbeddingProvider`. Medido contra esta base de conocimiento:

| Proveedor | Aciertos | Ruido | Umbral |
|---|---|---|---|
| `gemini-embedding-001` (semántico) | — | — | **0.35** (`AI_RETRIEVAL_MIN_SCORE`) |
| mock (léxico, por hashing) | 0.30 – 0.42 | < 0.20 | **0.25** |

Con un umbral único de 0.35, «¿Se pueden borrar usuarios?» acertaba su pasaje con **0.307** y se
descartaba. El golden set lo cazó.

## 6. Del pasaje a la cita

Los pasajes entran en el prompt numerados y delimitados, y el modelo debe citar `[KB-n]`. El
número, y no el nombre del archivo, permite que el validador compruebe que **cada cita apunta a un
pasaje que de verdad se recuperó**: una cita a un número inexistente es una alucinación de la forma
más detectable que hay, y se elimina del texto dejando constancia en `flags`.

La respuesta devuelve cada cita con su documento, su sección, su puntaje y un extracto, para que
quien lee pueda ir a la fuente.

## 7. Lo que no hace

- **Sin reordenamiento** (*rerank*) ni búsqueda híbrida léxico + vectorial. Con 32 pasajes y
  preguntas directas, la recuperación por vector basta; con un corpus grande sería lo primero que
  añadiría.
- **Sin fragmentación por tokens**: se cuenta en caracteres. Suficiente para documentos de tamaño
  conocido.
- **Sin reindexado automático** al cambiar un archivo: hay que reiniciar el servicio o llamar a
  `POST /api/v1/agent/knowledge-base/reindex` (permiso `kb:manage`).
