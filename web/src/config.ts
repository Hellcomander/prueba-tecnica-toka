export const API_MODE: 'mock' | 'real' =
  typeof __API_MODE__ === 'undefined' ? 'mock' : __API_MODE__;
