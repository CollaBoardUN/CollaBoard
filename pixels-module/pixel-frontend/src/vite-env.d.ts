/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_HTTP_URL?: string;
  readonly VITE_BACKEND_WS_URL?: string;
  readonly VITE_PIZARRA_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
