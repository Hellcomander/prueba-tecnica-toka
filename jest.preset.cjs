// Preset común de Jest para paquetes y servicios backend.
// Política de coverage (docs/coverage/README.md): gate en lines, statements y functions;
// branches se reporta pero no bloquea. Los adaptadores de infraestructura se excluyen del gate
// unitario y los cubre el smoke test contra el stack real.
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} rootDir
 * @param {{ threshold?: number, extraIgnore?: string[] }} [opts]
 */
module.exports = (rootDir, opts = {}) => {
  const threshold = opts.threshold ?? 70;
  return {
    rootDir,
    testEnvironment: 'node',
    roots: ['src', 'test'].filter((d) => fs.existsSync(path.join(rootDir, d))).map((d) => `<rootDir>/${d}`),
    testMatch: ['**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
      '^.+\\.ts$': ['ts-jest', { tsconfig: path.join(rootDir, 'tsconfig.json') }],
    },
    moduleNameMapper: {
      '^@toka/(contracts|nest-common)$': path.join(__dirname, 'packages/$1/src'),
      // El cliente generado por Prisma usa imports relativos con extensión .js (estilo node16).
      '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    maxWorkers: 2,
    workerIdleMemoryLimit: '512MB',
    clearMocks: true,
    collectCoverageFrom: [
      'src/**/*.ts',
      '!src/**/*.spec.ts',
      '!src/main.ts',
      '!src/**/*.module.ts',
      '!src/**/index.ts',
      '!src/generated/**',
      '!src/infrastructure/persistence/**/*.repository.ts',
      '!src/infrastructure/persistence/prisma.service.ts',
      '!src/infrastructure/messaging/**',
      '!src/infrastructure/cache/**',
      ...(opts.extraIgnore ?? []),
    ],
    coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
    coverageThreshold: {
      global: { lines: threshold, statements: threshold, functions: threshold },
    },
  };
};
