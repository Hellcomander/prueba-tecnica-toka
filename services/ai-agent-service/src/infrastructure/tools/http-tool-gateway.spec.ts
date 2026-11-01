import { TOOLS_BY_NAME } from '../../application/tools/catalog';
import { buildPath } from './http-tool-gateway';

const tool = (name: string) => TOOLS_BY_NAME.get(name)!;

describe('construcción de la ruta de una herramienta', () => {
  it('solo viajan los parámetros declarados: lo que el modelo invente se queda fuera', () => {
    const path = buildPath(tool('search_users'), { search: 'ana', status: 'ACTIVE', pageSize: 10, rm: '-rf', password: 'x' });
    expect(path).toBe('/api/v1/users?search=ana&status=ACTIVE&pageSize=10');
    expect(path).not.toContain('password');
  });

  it('codifica los parámetros de camino', () => {
    expect(buildPath(tool('get_user'), { userId: 'a b/../c' })).toBe('/api/v1/users/a%20b%2F..%2Fc');
  });

  it('un parámetro de camino ausente falla antes de salir a la red', () => {
    expect(() => buildPath(tool('get_user'), {})).toThrow(/Falta el parámetro userId/);
    expect(() => buildPath(tool('get_user'), { userId: '' })).toThrow(/Falta el parámetro/);
  });

  it('una herramienta sin parámetros produce la ruta limpia', () => {
    expect(buildPath(tool('get_user_stats'), {})).toBe('/api/v1/users/stats');
    expect(buildPath(tool('get_audit_stats'), { ruido: 1 })).toBe('/api/v1/audit/stats');
  });

  it('los valores vacíos no se envían como filtros vacíos', () => {
    expect(buildPath(tool('get_audit_events'), { type: '', limit: 5 })).toBe('/api/v1/audit/events?limit=5');
  });
});

describe('catálogo de herramientas', () => {
  it('todas son de solo lectura y declaran su permiso', () => {
    for (const definition of TOOLS_BY_NAME.values()) {
      expect(definition.method).toBe('GET');
      expect(definition.requiredPermission).toBeTruthy();
      expect(definition.schema.parameters.additionalProperties).toBe(false);
    }
  });

  it('cada herramienta apunta al servicio dueño del dato', () => {
    expect(tool('get_audit_events').target).toBe('audit');
    expect(tool('list_roles').target).toBe('role');
    expect(tool('search_users').target).toBe('user');
  });
});
