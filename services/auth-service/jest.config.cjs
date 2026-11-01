// Fuera del gate de coverage, igual que en role-service: los adaptadores que solo hablan con un
// proceso externo (argon2 nativo, HTTP hacia role-service) no se prueban con mocks, los cubre el
// smoke contra el stack real. La lógica interesante de S1 (fallback stale y falla cerrada) vive
// en application/services/authorization-resolver.ts y sí está medida.
module.exports = require('../../jest.preset.cjs')(__dirname, {
  extraIgnore: ['!src/infrastructure/security/**', '!src/infrastructure/http/**'],
});
