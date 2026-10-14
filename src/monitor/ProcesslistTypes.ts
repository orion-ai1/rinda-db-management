export interface ProcessItem {
  id: number;
  user: string;
  host: string;
  db: string | null;
  command: string;
  time: number;
  state: string | null;
  info: string | null;
  isCurrent: boolean;
}

export interface ProcesslistSnapshot {
  connectionId: string;
  connectionName: string;
  serverVersion?: string;
  currentConnectionId?: number;
  processes: ProcessItem[];
  totalCount: number;
  activeCount: number;
  maxTime: number;
  timestamp: number;
}

export interface KillProcessResult {
  ok: boolean;
  message: string;
  processId: number;
  queryOnly: boolean;
}
