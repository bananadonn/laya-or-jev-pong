/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAYA_PORT?: string;
  readonly VITE_LAYA_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
