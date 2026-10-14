export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  ssl: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionDraft {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl: boolean;
}
