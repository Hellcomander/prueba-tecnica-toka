# Evaluación del agente

> Cómo se mide si el asistente funciona, qué se mide, qué **no** se puede medir así, y qué salió.
> Los reportes generados están en [`reports/`](reports/).

## 1. Qué se mide y qué no

Un modelo de lenguaje no produce el mismo texto dos veces. Una prueba que compare cadenas mide la
suerte, no la calidad. Por eso el golden set separa dos cosas y **solo una cuenta para el
acierto**:

| | Qué comprueba | ¿Cuenta? |
|---|---|---|
| **Duras** | Hechos sobre la respuesta: qué documentos citó, qué herramientas usó, qué señales levantó, si el validador pasó, si el `viewer` recibió algo que no debía | **Sí** |
| **Blandas** | Indicios sobre el texto: si menciona «diez minutos», si dice «no puedo» | No, se reportan aparte |

Es la distinción que hace la medición honesta. «El `viewer` no recibió pasajes de auditoría» es un
hecho verificable y estable. «La respuesta está bien redactada» no lo es, y fingir que un `grep`
lo comprueba sería peor que no medirlo.

## 2. El golden set

12 casos en `scripts/eval/golden-set.mjs`, repartidos por lo que el agente debe hacer bien y por
lo que debe negarse a hacer:

| Categoría | Casos | Qué comprueba |
|---|---:|---|
| Base de conocimiento | 3 | Que la respuesta cite el documento correcto y no use herramientas |
| Herramientas | 3 | Que una pregunta de datos en vivo llame a `get_user_stats`, `list_roles`, `search_users` |
| Informe | 1 | El caso que justifica `get_audit_events`: «genera un reporte de accesos fallidos» |
| **Autorización** | 3 | Que el `viewer` no reciba pasajes ni herramientas de auditoría, y que nadie consiga una escritura |
| Inyección | 1 | Que se marque en `flags` y que el canario no salga |
| Fuera de tema | 1 | Que «no lo sé» sea la respuesta |

Los casos se ejecutan **con tres identidades distintas** (`admin`, `auditor`, `viewer`), porque la
mitad de lo que se evalúa es autorización y con un solo usuario no se vería.

## 3. El runner

```bash
npm run eval                                         # contra el proveedor configurado
npm run eval -- --label "vivo · flash" --out docs/ai/reports/live-flash.md
```

Tres decisiones del runner que importan:

- **Se auto-regula.** El agente limita a 4 consultas por usuario y 8 globales por minuto, así que
  lanzar doce seguidas mediría el limitador en vez del agente. El ritmo por defecto es de 8 s
  (`EVAL_PACE_MS`).
- **Respeta `Retry-After`.** Si aun así recibe un 422, espera lo que dice la cabecera en lugar de
  reintentar a ciegas: la misma regla que el agente aplica con el proveedor.
- **Registra el modelo que respondió de verdad**, por caso. Un reporte nunca puede mentir sobre
  con qué se midió: si el primario estaba sin cuota y contestó el de respaldo, se ve.

Sale con código distinto de cero si algún caso falla, así que sirve como puerta en CI — en modo
mock, que es determinista.

## 4. Resultados

Ver [`reports/`](reports/). Cada reporte dice su fecha, su proveedor, su modelo y su prompt.

| | [mock](reports/mock.md) | [vivo · `gemini-3.5-flash-lite`](reports/live-gemini-3.5-flash-lite.md) |
|---|---:|---:|
| Acierto (duras) | **100 %** | **100 %** |
| Indicios de calidad (blandas) | 57 % | 100 % |
| Latencia p50 | 34 ms | 1 763 ms |
| Latencia p95 | 84 ms | 8 760 ms |
| Tokens (entrada / salida / razonamiento / embeddings) | 15 110 / 515 / 0 / 177 | 49 273 / 635 / 1 495 / 177 |
| Costo del golden set | $0.005847 *(simulado)* | **$0.020134** |

Tres lecturas que vale la pena señalar:

**La misma mecánica, dos calidades de texto.** Las comprobaciones duras pasan al 100 % en ambos
modos: recuperación, ACL, herramientas, guardrails y límites funcionan igual. Los indicios de
texto pasan de 57 % a 100 %, y esa es exactamente la diferencia entre un proveedor que reconoce
intenciones por palabras clave y uno que redacta. **Es la demostración de que las dos métricas
miden cosas distintas**, y la razón de no sumarlas en un único número.

**La latencia es del modelo, no de la recuperación.** Con la misma recuperación debajo, el p50
pasa de 34 ms a 1,8 s. El tramo `retrievalMs` se mantiene en decenas de milisegundos en ambos.

**El p95 de 8,8 s tiene una causa concreta y no es una anomalía**: es el caso `tool-02`, el único
que llama a una herramienta *después* de haber recuperado contexto, lo que añade un segundo viaje
al modelo. Preferir el dato en vivo sobre el documentado **cuesta latencia**, y el golden set
pone número a ese intercambio en vez de dejarlo en intuición.

El costo en mock aparece porque el proveedor simula el conteo de tokens con los mismos precios;
no se paga nada. Sirve para comparar el **tamaño del prompt** entre versiones sin gastar cuota.

## 5. Lo que el golden set encontró

Esta es la parte que justifica el esfuerzo. La primera corrida dio **66,7 %**, y ninguna de las
causas era un caso mal escrito:

1. **El índice vectorial contenía vectores de otro modelo.** La ingesta era idempotente por el
   texto, pero un vector solo significa algo dentro del espacio del modelo que lo produjo. Al
   cambiar de Gemini a mock —misma dimensión, 768— Qdrant aceptó la consulta sin quejarse y
   devolvió ruido: puntajes de 0.01 a 0.04 y un orden sin sentido. Ni un error, ni una excepción:
   un asistente que contesta «no lo sé» a todo. El hash de la ingesta ahora incluye el modelo.
2. **El umbral de relevancia estaba en el sitio equivocado.** `AI_RETRIEVAL_MIN_SCORE=0.35` está
   calibrado para un embedding semántico; aplicado al léxico del mock descartaba aciertos de
   0.307. El umbral pasó a ser una propiedad del `EmbeddingProvider`.
3. **`\b` no casa después de una vocal acentuada.** En JavaScript el límite de palabra se define
   sobre `[A-Za-z0-9_]`, así que `/\bqué\b/` **nunca** casa con «¿Qué roles existen?». La
   herramienta `list_roles` no se disparaba mientras `get_user_stats` sí, porque «Cuántos» termina
   en una letra ASCII y «Qué» no.

4. **El modelo prefería el contexto a la herramienta.** A «¿Qué roles existen en la plataforma?»
   respondía con la base de conocimiento —correctamente citado— en vez de llamar a `list_roles`.
   La respuesta era **incompleta pareciendo completa**: la base documenta los tres roles de
   sistema, pero no puede conocer los que alguien haya creado después. Se corrigió en el prompt,
   diciendo explícitamente que para preguntas de **estado actual** la herramienta gana *aunque el
   contexto parezca responder*. Es el único de los cuatro que se arregló cambiando palabras y no
   código, y el reporte anterior y el nuevo están ambos en el historial.

Ninguno de los cuatro habría aparecido en una revisión de código ni en un test unitario escrito
sobre el mismo malentendido. Los cuatro los encontró medir el sistema entero contra respuestas
esperadas.

Y un quinto, en el propio runner: obedecía `Retry-After` **a ciegas**. Al agotarse el presupuesto
diario de tokens, el servidor contestó `Retry-After: 15905` —cuatro horas— y el runner se durmió
catorce minutos en silencio hasta que alguien lo paró. Ahora tiene un tope de espera y marca el
caso como no ejecutado. De paso destapó dos cosas más: que el mensaje decía «intenta de nuevo en
un momento» junto a esa cabecera de cuatro horas, y que **el presupuesto diario de tokens se
aplicaba también en modo mock**, donde no hay nada que proteger — así que quien probara el
asistente sin clave de API se bloqueaba durante horas tras un par de docenas de preguntas.

## 6. Costo y cuota

El costo se estima con precios configurables (`AI_PRICE_*_PER_MTOK`), porque un número de costo
que envejece en silencio es peor que no tenerlo. Los tokens de razonamiento se cobran como salida:
contarlos como entrada subestimaría el costo del modelo que más hay que vigilar.

**Cuota real del *free tier*** (medida el 1-nov-2026): `gemini-3.5-flash` agota
`generate_content_free_tier_requests` a las **20 peticiones diarias**, con `retryDelay` de ~13 h
hasta medianoche hora del Pacífico. `gemini-3.5-flash-lite` no se agotó en ninguna prueba.

Consecuencia práctica para evaluar: **un golden set de 12 casos consume más de la mitad de la
cuota diaria del modelo primario**. Por eso la corrida determinista es la de mock y la corrida en
vivo se hace con intención, no en cada cambio.

## 7. Lo que falta

- **Sin agregación.** Los números existen por consulta y en la auditoría, pero no hay serie
  temporal ni p95 continuo: el p95 de aquí es el del golden set, no el de producción.
- **Comparar `agent-v1` contra `agent-v2`** sobre el mismo golden set. El runner ya lo permite
  (`AI_PROMPT_VERSION`); falta la corrida y el reporte.
- **Sin evaluación de fidelidad** (*groundedness*): se comprueba que las citas apunten a pasajes
  reales, no que la afirmación citada se sostenga en el pasaje. Eso requiere un segundo modelo
  como juez, con su propio costo y su propio sesgo.
- **12 casos son pocos.** Cubren las seis categorías, pero un caso por categoría de riesgo es el
  mínimo, no un objetivo.
