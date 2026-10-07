export interface Env {
  DATABASE_URL: string;
  API_KEY?: string;
  APP_NAME?: string;
  MAX_USERNAME_COUNT?: string;
  MAX_EXCLUSION_COUNT?: string;
  MAX_CHUNK_ITEMS?: string;
  MAX_ZIP_FILES?: string;
  IMPORT_QUEUE?: Queue<ImportQueueMessage>;
}

export interface ImportQueueMessage {
  importId: string;
  kind: "finalize";
}

export interface ParsedExport {
  followers: Set<string>;
  following: Set<string>;
  discoveredFiles: string[];
  followerFiles: string[];
  followingFiles: string[];
  warnings: string[];
}
