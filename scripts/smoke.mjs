// Smoke test end-to-end: comprueba contra el stack real lo que los tests
// unitarios no pueden ver, porque vive entre procesos (JWT emitido por auth y validado por los
// otros tres, eventos que cruzan RabbitMQ, el correlationId que sobrevive el viaje completo).
//
//   npm run smoke
//
// Requiere el stack arriba con el override de desarrollo, que publica los servicios en
// 127.0.0.1:13001-13005 (ver docker-compose.dev.yml):
//   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build --wait
//
// Por qué el flujo funcional va directo a los servicios y no por el gateway: el gateway limita
// /api/v1/auth/login a 5 r/m por IP, y este smoke hace más de cinco logins a propósito
// (lockout, usuario suspendido, viewer). Medido por el gateway, el 429 de nginx taparía al 429
// del lockout, que es justo lo que se quiere distinguir. El borde (ruteo, 404 de /internal/*,
// headers de seguridad, rate limit) sí se prueba contra el gateway, en su propia sección.
//
// Es idempotente: cada corrida usa un email único, así que puede correrse dos veces seguidas
// (es parte del criterio de salida).

const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8080';
const SVC = {
  auth: process.env.SMOKE_AUTH_URL ?? 'http://127.0.0.1:13001',
  user: process.env.SMOKE_USER_URL ?? 'http://127.0.0.1:13002',
  role: process.env.SMOKE_ROLE_URL ?? 'http://127.0.0.1:13003',
  audit: process.env.SMOKE_AUDIT_URL ?? 'http://127.0.0.1:13004',
  agent: process.env.SMOKE_AGENT_URL ?? 'http://127.0.0.1:13005',
};

// Credenciales de los usuarios semilla. Son datos sintéticos de desarrollo; los defaults
// coinciden con los del compose y se pueden sobreescribir por entorno.
const SEED = {
  admin: { email: 'admin@toka.local', password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!demo' },
  auditor: { email: 'auditor@toka.local', password: process.env.SEED_AUDITOR_PASSWORD ?? 'Auditor123!demo' },
  viewer: { email: 'viewer@toka.local', password: process.env.SEED_VIEWER_PASSWORD ?? 'Viewer123!demo' },
};

const results = [];
let failed = 0;

/** Una comprobación con nombre. Nunca lanza: registra y sigue, para ver todo el panorama. */
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ ok: true, name, ms: Date.now() - t0, detail: detail ?? '' });
  } catch (err) {
    failed += 1;
    results.push({ ok: false, name, ms: Date.now() - t0, detail: err?.message ?? String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Cliente HTTP mínimo: propaga el correlationId y parsea JSON cuando lo hay. */
async function request(base, path, { method = 'GET', token, body, headers = {}, correlationId, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined; // p. ej. la página de error HTML de nginx
  }
  return { status: res.status, headers: res.headers, body: json, text, setCookie: res.headers.getSetCookie?.() ?? [] };
}

const login = (email, password, correlationId) =>
  request(SVC.auth, '/api/v1/auth/login', { method: 'POST', body: { email, password }, correlationId });

/** Espera a que una condición se cumpla: los efectos por evento son asíncronos. */
async function eventually(description, fn, { timeoutMs = 15_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timeout esperando: ${description}${last ? ` (último error: ${last.message})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const unique = Date.now().toString(36);
const newUser = {
  email: `smoke.${unique}@toka.test`,
  password: 'Smoke123!temporal',
  fullName: 'Smoke Test',
};

// Estado compartido entre pasos.
const state = {};

// ---------------------------------------------------------------------------
// 1. Salud del stack
// ---------------------------------------------------------------------------
await check('los 5 servicios responden /health/ready', async () => {
  for (const [name, base] of Object.entries(SVC)) {
    const res = await request(base, '/health/ready');
    assert(res.status === 200, `${name} devolvió ${res.status} en /health/ready`);
    assert(res.body?.status === 'ok', `${name} no está listo: ${res.text}`);
  }
  return 'auth, user, role, audit, ai-agent';
});

// ---------------------------------------------------------------------------
// 2. Borde: el gateway es el único punto de entrada
// ---------------------------------------------------------------------------
await check('el gateway bloquea /internal/* con 404', async () => {
  const res = await request(GATEWAY, '/internal/v1/authorizations/00000000-0000-4000-8000-000000000001');
  assert(res.status === 404, `esperaba 404 y llegó ${res.status}: el endpoint interno quedó expuesto`);
  return '404 como debe';
});

await check('el gateway manda los headers de seguridad', async () => {
  const res = await request(GATEWAY, '/healthz');
  assert(res.status === 200, `/healthz devolvió ${res.status}`);
  for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    assert(res.headers.get(h), `falta el header ${h}`);
  }
  return 'nosniff, DENY, strict-origin-when-cross-origin';
});

await check('el gateway rutea /api/v1/* al servicio dueño', async () => {
  // Sin token debe contestar el servicio (401), no nginx (404): prueba que el ruteo llega.
  const res = await request(GATEWAY, '/api/v1/roles');
  assert(res.status === 401, `esperaba 401 del servicio y llegó ${res.status}`);
  return 'role-service contesta detrás del gateway';
});

await check('el discovery OIDC y el JWKS son públicos', async () => {
  const disco = await request(GATEWAY, '/.well-known/openid-configuration');
  assert(disco.status === 200, `discovery devolvió ${disco.status}`);
  assert(disco.body?.issuer, 'el discovery no trae issuer');
  const jwks = await request(GATEWAY, '/.well-known/jwks.json');
  assert(jwks.status === 200, `jwks devolvió ${jwks.status}`);
  assert(Array.isArray(jwks.body?.keys) && jwks.body.keys.length > 0, 'el JWKS no trae llaves');
  assert(jwks.body.keys.every((k) => !k.d), 'el JWKS expone material privado');
  return `issuer ${disco.body.issuer}, ${jwks.body.keys.length} llave(s)`;
});

// ---------------------------------------------------------------------------
// 3. Login y validación distribuida del JWT
// ---------------------------------------------------------------------------
await check('login del admin devuelve access token y cookie de refresh', async () => {
  const res = await login(SEED.admin.email, SEED.admin.password);
  assert(res.status === 200, `login devolvió ${res.status}: ${res.text}`);
  const token = res.body?.accessToken ?? res.body?.access_token;
  assert(token, `la respuesta no trae accessToken: ${res.text}`);
  state.adminToken = token;

  const refresh = res.setCookie.find((c) => /refresh/i.test(c));
  assert(refresh, 'no llegó la cookie de refresh');
  assert(/HttpOnly/i.test(refresh), 'la cookie de refresh no es HttpOnly');
  assert(/SameSite=Strict/i.test(refresh), 'la cookie de refresh no es SameSite=Strict');
  state.adminCookie = refresh.split(';')[0];

  const [, payloadB64] = token.split('.');
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  assert(claims.sub && claims.sid && claims.jti, 'al JWT le faltan sub/sid/jti');
  assert(Array.isArray(claims.permissions) && claims.permissions.includes('users:write'), 'el admin no trae permissions en el token');
  state.adminId = claims.sub;
  return `${claims.roles?.join(',')} · ${claims.permissions.length} permisos`;
});

await check('el mismo JWT lo validan los 4 servicios (JWKS distribuido)', async () => {
  const probes = [
    ['auth', SVC.auth, '/api/v1/auth/userinfo'],
    ['user', SVC.user, '/api/v1/users/stats'],
    ['role', SVC.role, '/api/v1/roles'],
    ['audit', SVC.audit, '/api/v1/audit/events?limit=1'],
  ];
  for (const [name, base, path] of probes) {
    const res = await request(base, path, { token: state.adminToken });
    assert(res.status === 200, `${name} rechazó el token del admin: ${res.status} ${res.text}`);
  }
  return 'ningún servicio llama a auth para validar';
});

await check('sin token responde 401 y con permisos insuficientes 403', async () => {
  const anon = await request(SVC.role, '/api/v1/roles');
  assert(anon.status === 401, `sin token esperaba 401 y llegó ${anon.status}`);

  const viewer = await login(SEED.viewer.email, SEED.viewer.password);
  assert(viewer.status === 200, `no pude entrar como viewer: ${viewer.status} ${viewer.text}`);
  state.viewerToken = viewer.body?.accessToken ?? viewer.body?.access_token;

  const forbidden = await request(SVC.audit, '/api/v1/audit/events', { token: state.viewerToken });
  assert(forbidden.status === 403, `el viewer no debería leer auditoría, llegó ${forbidden.status}`);
  return '401 anónimo, 403 viewer en auditoría';
});

// ---------------------------------------------------------------------------
// 4. Errores con forma RFC 9457 (problem+json)
// ---------------------------------------------------------------------------
await check('un payload inválido devuelve 400 problem+json', async () => {
  const res = await request(SVC.auth, '/api/v1/accounts', {
    method: 'POST',
    token: state.adminToken,
    body: { email: 'no-es-un-email', password: '123', fullName: '' },
  });
  assert(res.status === 400, `esperaba 400 y llegó ${res.status}: ${res.text}`);
  assert(/application\/problem\+json/.test(res.headers.get('content-type') ?? ''), 'el content-type no es problem+json');
  assert(res.body?.title && res.body?.status === 400, `el cuerpo no tiene forma RFC 9457: ${res.text}`);
  return res.body.code ?? res.body.title;
});

// ---------------------------------------------------------------------------
// 5. Crear usuario: un evento, tres servicios, un solo correlationId
// ---------------------------------------------------------------------------
await check('crear usuario propaga perfil, rol y auditoría con el mismo correlationId', async () => {
  const correlationId = `smoke-${unique}-create`;
  const created = await request(SVC.auth, '/api/v1/accounts', {
    method: 'POST',
    token: state.adminToken,
    correlationId,
    body: newUser,
  });
  assert(created.status === 201, `crear cuenta devolvió ${created.status}: ${created.text}`);
  const userId = created.body?.id ?? created.body?.userId;
  assert(userId, `la respuesta no trae el id: ${created.text}`);
  state.newUserId = userId;

  // user-service crea el perfil al consumir account.registered
  await eventually('el perfil aparece en user-service', async () => {
    const res = await request(SVC.user, `/api/v1/users/${userId}`, { token: state.adminToken });
    return res.status === 200 && res.body?.email === newUser.email;
  });

  // role-service le asigna el rol por defecto
  const roles = await eventually('role-service le asigna el rol viewer', async () => {
    const res = await request(SVC.role, `/api/v1/user-roles/${userId}`, { token: state.adminToken });
    if (res.status !== 200) return false;
    const names = (res.body?.roles ?? []).map((r) => r.name ?? r);
    return names.includes('viewer') ? names : false;
  });

  // audit-service guardó el evento, con el correlationId que nació en la llamada HTTP
  const entry = await eventually('audit-service registró account.registered', async () => {
    const res = await request(SVC.audit, '/api/v1/audit/events?type=account.registered', { token: state.adminToken });
    if (res.status !== 200) return false;
    const items = res.body?.items ?? res.body?.events ?? res.body?.data ?? [];
    return items.find((e) => e.correlationId === correlationId) ?? false;
  });
  assert(entry.correlationId === correlationId, 'el correlationId no sobrevivió el viaje');
  return `${roles.join(',')} · correlationId propagado a auditoría`;
});

// ---------------------------------------------------------------------------
// 6. Bloqueo optimista
// ---------------------------------------------------------------------------
await check('una versión obsoleta devuelve 409', async () => {
  const current = await request(SVC.user, `/api/v1/users/${state.newUserId}`, { token: state.adminToken });
  assert(current.status === 200, `no pude leer el perfil: ${current.status}`);
  const version = current.body?.version;
  assert(typeof version === 'number', `el perfil no expone version: ${current.text}`);

  const ok = await request(SVC.user, `/api/v1/users/${state.newUserId}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { fullName: 'Smoke Test Editado', version },
  });
  assert(ok.status === 200, `la primera edición falló: ${ok.status} ${ok.text}`);

  const stale = await request(SVC.user, `/api/v1/users/${state.newUserId}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { fullName: 'Edición con versión vieja', version },
  });
  assert(stale.status === 409, `con versión obsoleta esperaba 409 y llegó ${stale.status}: ${stale.text}`);
  assert(stale.body?.code === 'VERSION_CONFLICT', `esperaba el código VERSION_CONFLICT: ${stale.text}`);
  return '409 VERSION_CONFLICT';
});

// ---------------------------------------------------------------------------
// 7. Suspender cierra la puerta en auth
// ---------------------------------------------------------------------------
await check('suspender al usuario le bloquea el login', async () => {
  const before = await login(newUser.email, newUser.password);
  assert(before.status === 200, `el usuario nuevo debería poder entrar antes de suspenderlo: ${before.status} ${before.text}`);

  const suspended = await request(SVC.user, `/api/v1/users/${state.newUserId}/suspend`, {
    method: 'POST',
    token: state.adminToken,
    body: { reason: 'smoke test' },
  });
  assert(suspended.status === 200 || suspended.status === 204, `suspender devolvió ${suspended.status}: ${suspended.text}`);

  // auth consume user.status_changed; el efecto es asíncrono
  await eventually('auth rechaza el login del usuario suspendido', async () => {
    const res = await login(newUser.email, newUser.password);
    return res.status === 401 || res.status === 403;
  });
  return 'login cerrado tras la suspensión';
});

// ---------------------------------------------------------------------------
// 8. Invariantes que se evalúan contra la base, no contra el token
// ---------------------------------------------------------------------------
await check('nadie se suspende a sí mismo (409 SELF_SUSPENSION)', async () => {
  const res = await request(SVC.user, `/api/v1/users/${state.adminId}/suspend`, {
    method: 'POST',
    token: state.adminToken,
    body: { reason: 'smoke test' },
  });
  assert(res.status === 409, `esperaba 409 y llegó ${res.status}: ${res.text}`);
  // El agregado evalúa SELF_SUSPENSION antes que LAST_ADMIN, así que este es el código correcto
  // aunque el admin sea además el último: se compara contra el id leído de la base, no contra
  // el claim del token.
  assert(res.body?.code === 'SELF_SUSPENSION', `esperaba SELF_SUSPENSION: ${res.text}`);
  return '409 SELF_SUSPENSION';
});

// La regla del último admin solo se puede provocar con un actor que tenga users:write y NO sea
// admin (si fuera admin y el único, saltaría SELF_SUSPENSION primero). Montarlo de punta a punta
// prueba lo más interesante de la arquitectura: que la proyección local de user-service, que se
// alimenta por eventos de role-service, es la que sostiene una regla que cruza dos contextos.
await check('no se puede suspender al último admin activo (409 LAST_ADMIN)', async () => {
  const roleName = `smoke-operator-${unique}`;
  const role = await request(SVC.role, '/api/v1/roles', {
    method: 'POST',
    token: state.adminToken,
    body: { name: roleName, description: 'Rol temporal del smoke test', permissions: ['users:read', 'users:write'] },
  });
  assert(role.status === 201, `crear el rol devolvió ${role.status}: ${role.text}`);
  state.tempRoleId = role.body.id;

  const operator = { email: `operator.${unique}@toka.test`, password: 'Operator123!temporal', fullName: 'Smoke Operator' };
  const account = await request(SVC.auth, '/api/v1/accounts', { method: 'POST', token: state.adminToken, body: operator });
  assert(account.status === 201, `crear la cuenta del operador devolvió ${account.status}: ${account.text}`);
  const operatorId = account.body?.id ?? account.body?.userId;
  state.operatorId = operatorId;
  // Su rol temporal tiene users:read y users:write, pero NO agent:use: es el único usuario del
  // stack sin permiso para el asistente, así que es con el que se comprueba el 403 de la Parte 2.
  state.operator = operator;

  // Se reintenta la asignación en vez de esperar un GET: la consulta devuelve 200 con lista
  // vacía aunque role-service todavía no conozca al usuario, mientras que el PUT falla de
  // verdad (user_roles tiene FK contra user_directory) hasta que llega account.registered.
  await eventually('role-service acepta asignarle el rol al operador', async () => {
    const res = await request(SVC.role, `/api/v1/user-roles/${operatorId}`, {
      method: 'PUT',
      token: state.adminToken,
      body: { roleIds: [state.tempRoleId] },
    });
    return res.status === 200;
  });

  // El token nuevo trae el permiso porque auth lo pide a role en el login (S1).
  const session = await eventually('el operador entra con users:write en su token', async () => {
    const res = await login(operator.email, operator.password);
    if (res.status !== 200) return false;
    const token = res.body?.accessToken ?? res.body?.access_token;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return claims.permissions?.includes('users:write') ? token : false;
  });

  const res = await request(SVC.user, `/api/v1/users/${state.adminId}/suspend`, {
    method: 'POST',
    token: session,
    body: { reason: 'smoke test' },
  });
  assert(res.status === 409, `esperaba 409 y llegó ${res.status}: ${res.text}`);
  assert(res.body?.code === 'LAST_ADMIN', `esperaba LAST_ADMIN: ${res.text}`);
  return '409 LAST_ADMIN, sostenido por la proyección alimentada por eventos';
});

// ---------------------------------------------------------------------------
// 9. Rotación del refresh
// ---------------------------------------------------------------------------
await check('el refresh rota: el token viejo deja de servir', async () => {
  const first = await request(SVC.auth, '/api/v1/auth/refresh', { method: 'POST', cookie: state.adminCookie });
  assert(first.status === 200, `el refresh devolvió ${first.status}: ${first.text}`);
  const rotated = first.setCookie.find((c) => /refresh/i.test(c));
  assert(rotated, 'el refresh no entregó una cookie nueva');
  assert(rotated.split(';')[0] !== state.adminCookie, 'la cookie de refresh no rotó');

  const reused = await request(SVC.auth, '/api/v1/auth/refresh', { method: 'POST', cookie: state.adminCookie });
  assert(reused.status === 401, `reusar el refresh viejo debería dar 401 y dio ${reused.status}`);
  state.adminCookie = rotated.split(';')[0];
  return 'rotación y rechazo de reúso';
});

// ---------------------------------------------------------------------------
// 10. Fuerza bruta: lockout de la aplicación (no el rate limit de nginx)
// ---------------------------------------------------------------------------
await check('tras varios intentos fallidos el lockout responde 429', async () => {
  const victim = `lockout.${unique}@toka.test`;
  let locked;
  for (let i = 0; i < 8; i += 1) {
    const res = await login(victim, 'ContraseñaIncorrecta1!');
    if (res.status === 429) {
      locked = res;
      break;
    }
    assert(res.status === 401, `intento ${i + 1}: esperaba 401 o 429 y llegó ${res.status}: ${res.text}`);
  }
  assert(locked, 'después de 8 intentos fallidos el lockout no se activó');
  assert(
    /application\/problem\+json/.test(locked.headers.get('content-type') ?? ''),
    'el 429 no viene del servicio (sin problem+json): puede ser el rate limit de nginx',
  );
  return `429 ${locked.body?.code ?? ''} desde el servicio`;
});

// ---------------------------------------------------------------------------
// 11. Logout
// ---------------------------------------------------------------------------
await check('logout invalida la sesión', async () => {
  const res = await request(SVC.auth, '/api/v1/auth/logout', { method: 'POST', token: state.adminToken, cookie: state.adminCookie });
  assert(res.status === 200 || res.status === 204, `logout devolvió ${res.status}: ${res.text}`);
  const after = await request(SVC.auth, '/api/v1/auth/refresh', { method: 'POST', cookie: state.adminCookie });
  assert(after.status === 401, `tras el logout el refresh debería dar 401 y dio ${after.status}`);
  return 'sesión cerrada';
});

// ---------------------------------------------------------------------------
// 12. Parte 2: el agente de IA
//
// Son exactamente TRES consultas al agente, a propósito: el limitador propio permite 4 por
// usuario y 8 globales por minuto (AI_USER_RPM / AI_GLOBAL_RPM), y el criterio de salida exige
// poder correr este smoke dos veces seguidas. Con tres por corrida cabe. Si se añade una
// comprobación más, hay que subir el límite o quitar otra.
//
// Funciona igual con Gemini y con el proveedor mock: lo que se comprueba es la mecánica
// (recuperación, citas verificables, herramientas, ACL), no la redacción del modelo.
// ---------------------------------------------------------------------------
await check('el agente responde citando la base de conocimiento', async () => {
  const res = await request(SVC.agent, '/api/v1/agent/query', {
    method: 'POST',
    token: state.adminToken,
    body: { question: '¿Quién puede suspender a un usuario?', useCache: false },
  });
  assert(res.status === 201 || res.status === 200, `la consulta devolvió ${res.status}: ${res.text}`);
  const answer = res.body;
  assert(answer.answer?.length > 0, 'la respuesta vino vacía');
  assert(Array.isArray(answer.citations) && answer.citations.length > 0, `no citó ningún pasaje (modo ${answer.mode})`);
  // Una cita solo vale si se puede verificar: cada [KB-n] del texto tiene que existir en la lista.
  const declared = new Set(answer.citations.map((c) => c.index));
  for (const match of answer.answer.matchAll(/\[KB-(\d+)\]/g)) {
    assert(declared.has(Number(match[1])), `el texto cita [KB-${match[1]}] y no está entre los pasajes devueltos`);
  }
  assert(answer.latency?.retrievalMs >= 0 && answer.latency?.llmMs >= 0, 'faltan los tramos de latencia');
  assert(typeof answer.usage?.costUsd === 'number', 'falta la estimación de costo');
  return `modo ${answer.mode} · ${answer.citations.length} cita(s) · ${answer.latency.totalMs} ms · ${answer.usage.costUsd} USD`;
});

await check('una pregunta de datos en vivo usa una herramienta con el token de quien pregunta', async () => {
  const res = await request(SVC.agent, '/api/v1/agent/query', {
    method: 'POST',
    token: state.adminToken,
    body: { question: '¿Cuántos usuarios activos hay en la plataforma?', useCache: false },
  });
  assert(res.status === 201 || res.status === 200, `la consulta devolvió ${res.status}: ${res.text}`);
  const used = (res.body.toolCalls ?? []).filter((call) => call.ok).map((call) => call.name);
  assert(used.includes('get_user_stats'), `esperaba get_user_stats y hubo: ${JSON.stringify(res.body.toolCalls)}`);
  return `${used.join(', ')} · modo ${res.body.mode}`;
});

await check('el viewer no ve herramientas ni pasajes de auditoría (ACL del RAG)', async () => {
  const viewer = await login(SEED.viewer.email, SEED.viewer.password);
  const token = viewer.body?.accessToken ?? viewer.body?.access_token;
  assert(token, `el login del viewer falló: ${viewer.status} ${viewer.text}`);

  const caps = await request(SVC.agent, '/api/v1/agent/capabilities', { token });
  assert(caps.status === 200, `capabilities devolvió ${caps.status}`);
  const toolNames = caps.body.tools.map((tool) => tool.name);
  assert(!toolNames.includes('get_audit_events'), `al viewer se le declaró get_audit_events: ${toolNames.join(', ')}`);
  assert(caps.body.knowledgeChunks > 0, 'la base de conocimiento está vacía: la ingesta no corrió');

  const res = await request(SVC.agent, '/api/v1/agent/query', {
    method: 'POST',
    token,
    body: { question: '¿Cómo consulto los intentos de acceso fallidos en la auditoría?', useCache: false },
  });
  assert(res.status === 201 || res.status === 200, `la consulta del viewer devolvió ${res.status}: ${res.text}`);
  const restringidos = (res.body.citations ?? []).filter((c) => c.docId.includes('auditoria'));
  assert(restringidos.length === 0, `el viewer recibió pasajes restringidos: ${restringidos.map((c) => c.docId).join(', ')}`);
  return `${toolNames.length} herramienta(s), ningún pasaje restringido, ${caps.body.knowledgeChunks} pasajes indexados`;
});

await check('el asistente niega por defecto: 401 sin token y 403 sin agent:use', async () => {
  const anonima = await request(SVC.agent, '/api/v1/agent/query', { method: 'POST', body: { question: '¿Quién puede suspender usuarios?' } });
  assert(anonima.status === 401, `sin token esperaba 401 y llegó ${anonima.status}`);

  // El operador tiene users:read y users:write por su rol temporal, pero no agent:use.
  const operador = await login(state.operator.email, state.operator.password);
  const token = operador.body?.accessToken ?? operador.body?.access_token;
  assert(token, `el login del operador falló: ${operador.status} ${operador.text}`);

  const res = await request(SVC.agent, '/api/v1/agent/query', { method: 'POST', token, body: { question: '¿Quién puede suspender usuarios?' } });
  assert(res.status === 403, `sin agent:use esperaba 403 y llegó ${res.status}: ${res.text}`);
  assert(res.body?.code === 'FORBIDDEN', `esperaba el código FORBIDDEN y llegó ${res.body?.code}`);
  // Ni siquiera llega a consultar sus capacidades.
  const caps = await request(SVC.agent, '/api/v1/agent/capabilities', { token });
  assert(caps.status === 403, `capabilities sin agent:use devolvió ${caps.status}`);
  return '401 anónimo, 403 sin agent:use (consulta y capabilities)';
});

await check('la consulta al agente queda auditada sin guardar el texto de la pregunta', async () => {
  const auditor = await login(SEED.auditor.email, SEED.auditor.password);
  const token = auditor.body?.accessToken ?? auditor.body?.access_token;
  const page = await eventually(
    'el evento agent.query_completed llega a la auditoría',
    async () => {
      const res = await request(SVC.audit, '/api/v1/audit/events?type=agent.query_completed&limit=5', { token });
      return res.status === 200 && res.body.items?.length > 0 ? res.body : null;
    },
    { timeoutMs: 20_000 },
  );
  const entry = page.items[0];
  assert(entry.category === 'AI', `la categoría debería ser AI y es ${entry.category}`);
  assert(/^[0-9a-f]{64}$/.test(entry.data?.questionHash ?? ''), 'falta el hash de la pregunta');
  const serialized = JSON.stringify(entry);
  assert(!serialized.includes('suspender'), 'el evento guardó el texto de la pregunta');
  assert(typeof entry.data?.estimatedCostUsd === 'number', 'el evento no reporta el costo');
  return `${page.items.length} evento(s) de IA · solo hash, sin texto`;
});

// ---------------------------------------------------------------------------
// 13. Limpieza de lo que creó el smoke (los usuarios quedan: la auditoría es append-only y
//     borrarlos escondería la evidencia de que la corrida pasó)
// ---------------------------------------------------------------------------
await check('limpieza: se quita el rol temporal', async () => {
  if (!state.tempRoleId) return 'nada que limpiar';
  const admin = await login(SEED.admin.email, SEED.admin.password);
  const token = admin.body?.accessToken ?? admin.body?.access_token;
  await request(SVC.role, `/api/v1/user-roles/${state.operatorId}`, { method: 'PUT', token, body: { roleIds: [] } });
  const del = await request(SVC.role, `/api/v1/roles/${state.tempRoleId}`, { method: 'DELETE', token });
  assert(del.status === 204, `borrar el rol temporal devolvió ${del.status}: ${del.text}`);
  return 'rol temporal borrado';
});

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------
console.log('');
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FALLA';
  console.log(`${mark.padEnd(5)} ${r.name} (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
}
console.log('');
console.log(`${results.length - failed}/${results.length} comprobaciones en verde`);
process.exit(failed === 0 ? 0 : 1);
