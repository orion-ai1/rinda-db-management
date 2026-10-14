import type { QueryResult } from '../query/QueryService.js';

export interface ColumnMetadata {
  name: string;
  ordinal: number;
  dataType: string;
  columnType: string;
  nullable: boolean;
  characterMaximumLength?: number;
  numericPrecision?: number;
  numericScale?: number;
  extra: string;
  generationExpression?: string;
  characterSet?: string;
}

export interface IndexColumnMetadata {
  name: string;
  sequence: number;
  nullable: boolean;
  prefixLength?: number;
}

export interface UniqueIndexMetadata {
  name: string;
  primary: boolean;
  columns: IndexColumnMetadata[];
}

export interface TableEditMetadata {
  database: string;
  table: string;
  columns: ColumnMetadata[];
  uniqueIndexes: UniqueIndexMetadata[];
}

export interface RowLocator {
  kind: 'primary' | 'unique';
  indexName: string;
  columns: string[];
  permitsNullableValues: boolean;
}

export interface RowSnapshot {
  database: string;
  table: string;
  columnNames: string[];
  values: Array<string | null>;
  locator: RowLocator;
  metadataSignature: string;
}

export interface EditColumnView {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  editable: boolean;
  autoIncrement?: boolean;
  multiline: boolean;
  maximumLength?: number;
  readOnlyReason?: string;
}

export interface EditableRowView {
  token?: string;
  locatorValues?: Array<{ name: string; value: string }>;
  readOnlyReason?: string;
}

export interface TableEditingView {
  sessionId: string;
  database: string;
  table: string;
  enabled: boolean;
  deletionEnabled: boolean;
  reason?: string;
  editReason?: string;
  locatorLabel?: string;
  columns: EditColumnView[];
  rows: EditableRowView[];
}

export interface RowEditRequest {
  token: string;
  operationId: string;
  changes: unknown;
}

export interface RowEditOutcome {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  conflict?: boolean;
  affectedRows?: number;
}

export interface BatchRowEditRequest {
  token: string;
  changes: unknown;
}

export interface BatchEditRequest {
  operationId: string;
  edits: BatchRowEditRequest[];
}

export interface BatchEditOutcome extends RowEditOutcome {
  reloadedRows?: Array<{ token: string; values: Array<string | null> }>;
  rowFieldErrors?: Record<string, Record<string, string>>;
}

export interface RowDeleteRequest {
  token?: string;
  tokens?: string[];
  operationId: string;
  confirmation: string;
}

export interface BatchRowDeleteRequest {
  tokens: string[];
  operationId: string;
  confirmation: string;
}

export interface EditableTablePage {
  result: QueryResult;
  editing: TableEditingView;
  updateRow: (request: RowEditRequest) => Promise<RowEditOutcome>;
  updateRows: (request: BatchEditRequest) => Promise<BatchEditOutcome>;
  deleteRow: (request: RowDeleteRequest) => Promise<RowEditOutcome>;
  deleteRows: (request: BatchRowDeleteRequest) => Promise<RowEditOutcome>;
  insertRow?: (request: { operationId: string; values: Record<string, unknown> }) => Promise<RowEditOutcome>;
}
