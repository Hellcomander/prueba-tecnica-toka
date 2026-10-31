// Pruebas de integración contra infraestructura real (RabbitMQ). No cuentan para el coverage.
const base = require('../../jest.preset.cjs')(__dirname);
module.exports = { ...base, testMatch: ['**/*.int-spec.ts'], testTimeout: 40_000, collectCoverage: false, coverageThreshold: undefined };
