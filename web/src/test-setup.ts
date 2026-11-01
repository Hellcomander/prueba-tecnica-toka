import '@testing-library/jest-dom';

// Vite inyecta __API_MODE__ en el build; Jest no, así que se declara aquí. Los tests corren en
// modo demo a propósito: son deterministas y no necesitan el stack levantado.
(globalThis as typeof globalThis & { __API_MODE__: string }).__API_MODE__ = 'mock';
