export interface DesignerColumn {
  id: string;
  name: string;
  originalName?: string;
  dataType: string;
  length?: string;
  scale?: string;
  notNull: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
  collation?: string;
  autoIncrement?: boolean;
  comment?: string;
}

export interface DesignerIndex {
  id: string;
  name: string;
  originalName?: string;
  columns: string[];
  type: 'INDEX' | 'UNIQUE' | 'FULLTEXT';
  method?: 'BTREE' | 'HASH' | '';
  comment?: string;
}

export interface TableOptions {
  engine: string;
  charset: string;
  collation: string;
  autoIncrement?: string;
  comment: string;
}

export interface TableDesignerState {
  mode: 'create' | 'alter';
  connectionId: string;
  database: string;
  tableName: string;
  originalTableName?: string;
  columns: DesignerColumn[];
  originalColumns?: DesignerColumn[];
  indexes?: DesignerIndex[];
  originalIndexes?: DesignerIndex[];
  options: TableOptions;
  originalOptions?: TableOptions;
}

export interface TableDesignerValidation {
  valid: boolean;
  errors: string[];
}
