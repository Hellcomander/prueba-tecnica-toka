/**
 * Regla de dependencias de Clean Architecture, verificada en CI con `npm run lint:arch`.
 *   domain          → no depende de nada (TS puro; ni Nest, ni Prisma, ni otras capas)
 *   application     → solo domain (+ @nestjs/common para @Injectable/@Inject y @toka/contracts)
 *   infrastructure  → implementa los puertos de domain/application
 *   interface       → controllers delgados que llaman casos de uso
 * Además: ningún servicio importa a otro, y los paquetes compartidos no importan servicios.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'El dominio es TypeScript puro: solo puede importar otros archivos de domain y builtins de Node.',
      from: { path: '^services/[^/]+/src/domain/' },
      to: {
        pathNot: ['^services/[^/]+/src/domain/', '^node:'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'application-no-outer-layers',
      severity: 'error',
      comment: 'Los casos de uso no conocen infraestructura ni la capa HTTP; dependen de puertos.',
      from: { path: '^services/[^/]+/src/application/' },
      to: { path: '^services/[^/]+/src/(infrastructure|interface)/' },
    },
    {
      name: 'application-no-frameworks',
      severity: 'error',
      comment:
        'application solo puede usar @nestjs/common (DI) y @nestjs-cls/transactional (@Transactional, ' +
        'que no conoce el ORM); nada de Prisma, Mongoose, amqp, Redis, axios o Express. ' +
        'npm-no-pkg cubre paquetes hoisteados que el servicio no declara (llegan transitivos).',
      from: { path: '^services/[^/]+/src/application/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-peer', 'npm-optional', 'npm-no-pkg', 'npm-unknown'],
        pathNot: ['node_modules/@nestjs/common/', 'node_modules/@nestjs-cls/transactional/', 'node_modules/tslib/'],
      },
    },
    {
      name: 'no-generated-client-outside-infrastructure',
      severity: 'error',
      comment: 'El cliente generado de Prisma solo se usa en infrastructure (mappers y repositorios).',
      from: { path: '^services/[^/]+/src/', pathNot: '^services/[^/]+/src/(infrastructure|generated)/' },
      to: { path: '^services/[^/]+/src/generated/' },
    },
    {
      name: 'no-cross-service-imports',
      severity: 'error',
      comment: 'Los servicios solo se integran por HTTP y AMQP con contratos versionados.',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/', pathNot: '^services/$1/' },
    },
    {
      name: 'packages-no-services',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^services/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: { pathNot: '/src/generated/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Anclado a la salida propia del repo: un '/dist/' suelto descartaría también las
    // dependencias npm que publican en dist/ (axios, pino…) y las reglas no las verían.
    exclude: { path: ['^(packages|services)/[^/]+/(dist|coverage|test)/', '\\.spec\\.ts$'] },
    tsPreCompilationDeps: true,
    // paths de @toka/* hacia src: el resultado no depende de si los paquetes ya se compilaron.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
