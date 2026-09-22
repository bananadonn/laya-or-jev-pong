/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAYA_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
