# Diseño del agente

> Qué hace el asistente, qué no puede hacer, y por qué está construido así.
> El RAG en detalle: [`rag-pipeline.md`](rag-pipeline.md) · Los prompts:
> [`prompt-engineering.md`](prompt-engineering.md) · Las mediciones:
> [`evaluation.md`](evaluation.md).

## 1. Qué resuelve

Responde preguntas sobre las políticas internas citando la base de conocimiento, y consulta datos
en vivo de la plataforma —usuarios, roles, auditoría— con **los permisos de quien pregunta**.
Solo lee: no existe ninguna herramienta que cree, modifique o suspenda nada.

## 2. La decisión que lo define: el agente no puede ver más que el usuario

Es la decisión de la que cuelgan casi todas las demás, y hay **tres candados independientes**
sobre la misma propiedad, a propósito:

1. **Al modelo solo se le declaran las herramientas que los permisos del token autorizan.** Un
   `viewer` no ve siquiera que existe `get_audit_events`: no puede pedir algo cuya existencia
   desconoce.
2. **Antes de invocar se vuelve a comprobar**, por si el modelo inventa un nombre de herramienta.
3. **Se reenvía el JWT del usuario**, no un token de servicio del agente, así que `user`, `role` y
   `audit` vuelven a autorizar con sus guards de siempre.

El tercero es el importante y merece defenderse: un token de servicio con lectura sobre todo
convertiría al agente en el **único** punto donde se decide qué ve cada quién, y un fallo ahí
sería total y silencioso. Reenviando el token del usuario, aun si una inyección convenciera al
modelo, no podría obtener nada que la persona no pudiera obtener por sí misma.

La misma regla gobierna la recuperación: el ACL se aplica **dentro de la consulta** al store
vectorial, no filtrando los resultados después, así que un pasaje prohibido nunca llega a estar en
memoria del proceso.

## 3. Puertos y adaptadores

El servicio sigue la misma Clean Architecture que el resto del repositorio
([`../ddd-clean-architecture.md`](../ddd-clean-architecture.md)). Cuatro puertos definen todo lo
que el agente necesita del mundo:

| Puerto | Qué abstrae | Adaptadores |
|---|---|---|
| `LlmProvider` | Generar texto y pedir herramientas | Gemini · Mock |
| `EmbeddingProvider` | Vectorizar texto, y **decir qué similitud considera relevante** | Gemini · Mock |
| `VectorStore` | Guardar y buscar pasajes con filtro de ACL | Qdrant · en memoria (tests) |
| `ToolGateway` | Ejecutar una herramienta contra un microservicio | HTTP resiliente · fake (tests) |

Más `RateLimiter`, `AnswerCache` y `KnowledgeSource`. Gracias a esto, el caso de uso completo
—recuperación, bucle de herramientas, escalera de degradación, validación— se prueba **sin red,
sin Docker y sin API key**.

**`minScore` vive en `EmbeddingProvider` y no en la configuración general.** Parece un detalle y no
lo es: un embedding semántico y uno léxico no producen la misma escala de similitud, así que un
umbral único descarta aciertos en uno o cuela ruido en el otro. Lo descubrió el golden set
(ver [`evaluation.md`](evaluation.md)).

## 4. El recorrido de una pregunta

1. **Límites propios** en Redis, *antes* de gastar nada. Si no hay presupuesto, `422` con
   `Retry-After`: el usuario sabe cuántos segundos faltan.
2. **Caché**, con los permisos dentro de la clave. Dos personas con permisos distintos recuperan
   pasajes distintos; compartir su respuesta sería una fuga de autorización disfrazada de
   optimización.
3. **Recuperación** con el ACL aplicado en la consulta.
4. **Guardrail de entrada**: se revisan la pregunta *y los pasajes recuperados*. La inyección
   indirecta —texto hostil dentro de un documento— es el vector que de verdad importa en un RAG.
5. **Bucle de herramientas**, máximo 4 pasos. El turno del modelo se reenvía **intacto**, firma
   opaca incluida.
6. **Validación de salida**: canario, citas verificables, secretos.
7. **Publicación** de `agent.query_completed` con el hash de la pregunta, nunca su texto.

## 5. Herramientas

Siete, todas de solo lectura, cada una atada al permiso que ya exige el endpoint al que llama:

| Herramienta | Permiso | Servicio |
|---|---|---|
| `search_users`, `get_user`, `get_user_stats` | `users:read` | user |
| `list_roles`, `get_user_roles` | `roles:read` | role |
| `get_audit_events`, `get_audit_stats` | `audit:read` | audit |

Los parámetros se declaran con JSON Schema y `additionalProperties: false`, y la ruta se construye
**desde la definición**, no desde lo que diga el modelo: un argumento inventado no viaja.

## 6. Qué pasa cuando algo falla

| Escalón | Cuándo | Qué recibe el usuario |
|---|---|---|
| Modelo primario | Normal | Respuesta completa |
| Modelo de respaldo | El primario falló **esta** petición | Respuesta completa, con el motivo visible |
| Solo recuperación | Ningún modelo respondió, pero hay pasajes | Los pasajes citados, sin redactar |
| `503` | Ni modelo ni pasajes | Error honesto con `code`, `correlationId` y `Retry-After` |

La decisión se toma **por petición**, no con una media móvil: no hace falta estado compartido
entre instancias y nadie espera a que una ventana estadística se convenza de que el proveedor está
mal. El motivo viaja en las señales (`degraded:fallback_model:rate_limited`) porque *agotar la
cuota* y *tardar demasiado* se arreglan de formas opuestas.

**Nunca se inventa una respuesta para tapar una caída.** Es el mismo principio que gobierna la
llamada S1 de `auth` a `role`: fallar cerrado y decirlo.

## 7. Límites conocidos

- **Sin memoria de conversación.** Cada pregunta es independiente. Añadirla implica decidir dónde
  se guarda un historial que puede contener nombres de personas, y esa decisión no se tomó.
- **Sin límite de concurrencia** hacia los microservicios: hay timeout y cortacircuitos, pero
  nada acota las llamadas en vuelo (ver H7 de [`../ejercicio-4-diagnostico.md`](../ejercicio-4-diagnostico.md)).
- **El detector de inyección es heurístico** y no pretende otra cosa: marca, no bloquea. La defensa
  real es estructural (§2).
- **La ingesta corre al arrancar**, no hay reindexado por cambio de archivo sin reiniciar o llamar
  a `POST /api/v1/agent/knowledge-base/reindex`.
