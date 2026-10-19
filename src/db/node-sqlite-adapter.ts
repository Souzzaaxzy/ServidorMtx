// ──────────────────────────────────────────────────────────────
// Prisma driver adapter backed by Node's BUILT-IN `node:sqlite`.
//
// WHY THIS EXISTS
// Prisma's default SQLite path uses a Rust query engine binary. Prisma ships
// no Android/bionic build of it, so on Termux the binary cannot be loaded
// (`dlopen ... is for EM_X86_64 instead of EM_AARCH64`) and migrations/startup
// fail. The official fix — `@prisma/adapter-better-sqlite3` — needs a
// node-gyp native build, which is not reliable on Termux either.
//
// `node:sqlite` ships inside Node itself (no compilation, no prebuilt binary),
// so pairing it with Prisma's Rust-free query compiler (`engineType = "client"`
// in schema.prisma) makes Prisma work on Termux, Android ARM64 and any Linux
// host with Node >= 22.5 — with a single code path everywhere.
//
// The conversion and error-mapping logic mirrors the official
// `@prisma/adapter-better-sqlite3` so the application observes the SAME
// behavior (P2002/P2003 codes, DateTime handling, BigInt handling).
// ──────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ArgType,
  type ColumnType,
  type ConnectionInfo,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlDriverAdapterFactory,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions,
} from '@prisma/driver-adapter-utils';

const PROVIDER = 'sqlite' as const;
const ADAPTER_NAME = 'matrix-node-sqlite';

// ── Declared SQLite column type -> Prisma ColumnType ───────────
// Mirrors the official adapter's mapDeclType.
function mapDeclType(declType: string | null): ColumnType | null {
  switch ((declType ?? '').toUpperCase()) {
    case 'INT':
    case 'INTEGER':
    case 'TINYINT':
    case 'SMALLINT':
    case 'MEDIUMINT':
    case 'SERIAL':
    case 'INT2':
      return ColumnTypeEnum.Int32;
    case 'BIGINT':
    case 'UNSIGNED BIG INT':
    case 'INT8':
      return ColumnTypeEnum.Int64;
    case 'FLOAT':
      return ColumnTypeEnum.Float;
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'NUMERIC':
    case 'REAL':
      return ColumnTypeEnum.Double;
    case 'DATETIME':
    case 'TIMESTAMP':
      return ColumnTypeEnum.DateTime;
    case 'TIME':
      return ColumnTypeEnum.Time;
    case 'DATE':
      return ColumnTypeEnum.Date;
    case 'BLOB':
      return ColumnTypeEnum.Bytes;
    case 'BOOLEAN':
      return ColumnTypeEnum.Boolean;
    case 'JSONB':
      return ColumnTypeEnum.Json;
    case 'TEXT':
    case 'CLOB':
    case 'CHARACTER':
    case 'VARCHAR':
    case 'VARYING CHARACTER':
    case 'NCHAR':
    case 'NATIVE CHARACTER':
    case 'NVARCHAR':
      return ColumnTypeEnum.Text;
    default:
      return null;
  }
}

function inferColumnType(value: unknown): ColumnType {
  switch (typeof value) {
    case 'string':
      return ColumnTypeEnum.Text;
    case 'bigint':
      return ColumnTypeEnum.Int64;
    case 'boolean':
      return ColumnTypeEnum.Boolean;
    case 'number':
      return ColumnTypeEnum.UnknownNumber;
    case 'object':
      return value instanceof Uint8Array || value instanceof ArrayBuffer
        ? ColumnTypeEnum.Bytes
        : ColumnTypeEnum.Text;
    default:
      return ColumnTypeEnum.Text;
  }
}

// Columns whose declared type Prisma cannot classify fall back to the first
// non-null value (e.g. computed columns from `SELECT COUNT(*) AS c`).
function getColumnTypes(declaredTypes: Array<string | null>, rows: unknown[][]): ColumnType[] {
  const columnTypes: Array<ColumnType | null> = declaredTypes.map(mapDeclType);
  const emptyIndices = new Set<number>();
  columnTypes.forEach((t, i) => {
    if (t === null) emptyIndices.add(i);
  });
  if (emptyIndices.size === 0) return columnTypes as ColumnType[];

  columnLoop: for (const i of emptyIndices) {
    for (const row of rows) {
      const value = row[i];
      if (value !== null && value !== undefined) {
        columnTypes[i] = inferColumnType(value);
        continue columnLoop;
      }
    }
    columnTypes[i] = ColumnTypeEnum.Int32;
  }
  return columnTypes as ColumnType[];
}

// ── Prisma value -> node:sqlite bind value ─────────────────────
// `timestampFormat` defaults to 'unixepoch-ms' because Prisma's native SQLite
// driver stored DateTime as an epoch-milliseconds INTEGER; keeping that format
// means existing data/matrix.db files stay byte-compatible.
export type AdapterOptions = { timestampFormat?: 'unixepoch-ms' | 'iso8601' };

function toTimestamp(value: Date, options?: AdapterOptions): number | string {
  return (options?.timestampFormat ?? 'unixepoch-ms') === 'unixepoch-ms'
    ? value.getTime()
    : value.toISOString().replace('Z', '+00:00');
}

function mapArg(arg: unknown, argType: ArgType, options?: AdapterOptions): unknown {
  if (arg === null || arg === undefined) return null;
  const scalar = argType?.scalarType;

  if (typeof arg === 'string') {
    if (scalar === 'int') return Number.parseInt(arg, 10);
    if (scalar === 'float' || scalar === 'decimal') return Number.parseFloat(arg);
    if (scalar === 'bigint') return BigInt(arg);
    if (scalar === 'datetime') {
      const d = new Date(arg);
      return Number.isNaN(d.getTime()) ? arg : toTimestamp(d, options);
    }
    if (scalar === 'bytes') return Buffer.from(arg, 'base64');
  }
  if (typeof arg === 'boolean') return arg ? 1 : 0;
  if (arg instanceof Date) return toTimestamp(arg, options);
  if (typeof arg === 'bigint') {
    const asNumber = Number(arg);
    return Number.isSafeInteger(asNumber) ? asNumber : arg.toString();
  }
  if (Array.isArray(arg) || (typeof arg === 'object' && arg !== null)) {
    return JSON.stringify(arg);
  }
  return arg;
}

// ── node:sqlite value -> Prisma value ──────────────────────────
function mapRow(row: unknown[], columnTypes: ColumnType[]): unknown[] {
  const result: unknown[] = [];
  for (let i = 0; i < row.length; i++) {
    const value = row[i];
    const type = columnTypes[i];
    if (
      typeof value === 'number' &&
      (type === ColumnTypeEnum.Int32 || type === ColumnTypeEnum.Int64) &&
      !Number.isInteger(value)
    ) {
      result[i] = Math.trunc(value);
      continue;
    }
    if (
      (typeof value === 'number' || typeof value === 'bigint') &&
      (type === ColumnTypeEnum.DateTime || type === ColumnTypeEnum.Date)
    ) {
      result[i] = new Date(Number(value)).toISOString();
      continue;
    }
    if (typeof value === 'bigint') {
      const asNumber = Number(value);
      result[i] = Number.isSafeInteger(asNumber) ? asNumber : value.toString();
      continue;
    }
    result[i] = value;
  }
  return result;
}

// ── SQLite error -> Prisma error kind ──────────────────────────
// Mirrors the official adapter's convertDriverError so the app keeps seeing
// P2002 (unique) and P2003 (foreign key) — src/utils/errors.ts depends on it.
function convertDriverError(error: unknown) {
  const err = error as { message?: string; errcode?: number };
  const msg = err?.message ?? String(error);
  const extended = Number(err?.errcode ?? 0);
  const base = extended & 0xff;

  if (base === 19 /* SQLITE_CONSTRAINT */) {
    if (/UNIQUE constraint failed/i.test(msg)) {
      const cols = msg.split('constraint failed: ').at(1)?.split(', ');
      const fields = cols?.map((f) => f.split('.').pop() as string);
      const table = cols?.at(0)?.split('.').slice(0, -1).join('.') || undefined;
      return {
        originalCode: String(extended),
        originalMessage: msg,
        kind: 'UniqueConstraintViolation' as const,
        constraint: fields ? { fields } : undefined,
        table,
      };
    }
    if (/NOT NULL constraint failed/i.test(msg)) {
      const fields = msg
        .split('constraint failed: ')
        .at(1)
        ?.split(', ')
        .map((f) => f.split('.').pop() as string);
      return {
        originalCode: String(extended),
        originalMessage: msg,
        kind: 'NullConstraintViolation' as const,
        constraint: fields ? { fields } : undefined,
      };
    }
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return {
        originalCode: String(extended),
        originalMessage: msg,
        kind: 'ForeignKeyConstraintViolation' as const,
        constraint: { foreignKey: {} },
      };
    }
  }
  if (base === 5 /* SQLITE_BUSY */) {
    return { originalCode: String(extended), originalMessage: msg, kind: 'SocketTimeout' as const };
  }
  if (/no such table/i.test(msg)) {
    return { kind: 'TableDoesNotExist' as const, table: msg.split(': ').at(1) };
  }
  if (/no such column/i.test(msg)) {
    return { kind: 'ColumnNotFound' as const, column: msg.split(': ').at(1) };
  }
  return {
    originalCode: String(extended),
    originalMessage: msg,
    kind: 'sqlite' as const,
    extendedCode: extended,
    message: msg,
  };
}

interface PerformedQuery {
  columnNames: string[];
  columnTypes: ColumnType[];
  rows: unknown[][];
}

class NodeSQLiteQueryable {
  readonly provider = PROVIDER;
  readonly adapterName = ADAPTER_NAME;

  constructor(
    protected readonly client: DatabaseSync,
    protected readonly adapterOptions?: AdapterOptions,
  ) {}

  protected performIO(query: SqlQuery): PerformedQuery {
    const args = query.args.map((arg, i) => mapArg(arg, query.argTypes[i], this.adapterOptions));
    const stmt = this.client.prepare(query.sql);
    const columns = stmt.columns();
    if (columns.length === 0) {
      stmt.run(...(args as never[]));
      return { columnNames: [], columnTypes: [], rows: [] };
    }
    const columnNames = columns.map((c) => c.name);
    const rawRows = stmt.all(...(args as never[])) as Array<Record<string, unknown>>;
    const rows = rawRows.map((r) => columnNames.map((n) => r[n]));
    const declaredTypes = columns.map((c) => (c as { type?: string | null }).type ?? null);
    return { columnNames, columnTypes: getColumnTypes(declaredTypes, rows), rows };
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    try {
      const { columnNames, columnTypes, rows } = this.performIO(query);
      return {
        columnNames,
        columnTypes,
        rows: rows.map((row) => mapRow(row, columnTypes)),
      };
    } catch (e) {
      throw new DriverAdapterError(convertDriverError(e));
    }
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    try {
      const args = query.args.map((arg, i) => mapArg(arg, query.argTypes[i], this.adapterOptions));
      const stmt = this.client.prepare(query.sql);
      const result = stmt.run(...(args as never[]));
      return Number(result.changes);
    } catch (e) {
      throw new DriverAdapterError(convertDriverError(e));
    }
  }
}

class NodeSQLiteTransaction extends NodeSQLiteQueryable implements Transaction {
  readonly options: TransactionOptions;

  constructor(client: DatabaseSync, options: TransactionOptions, adapterOptions?: AdapterOptions) {
    super(client, adapterOptions);
    this.options = options;
  }

  // The Prisma query compiler issues COMMIT/ROLLBACK itself via executeRaw;
  // these only signal completion (same contract as the official adapter).
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}

  async createSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `SAVEPOINT ${name}`, args: [], argTypes: [] });
  }
  async rollbackToSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `ROLLBACK TO ${name}`, args: [], argTypes: [] });
  }
  async releaseSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `RELEASE SAVEPOINT ${name}`, args: [], argTypes: [] });
  }
}

class NodeSQLiteAdapter extends NodeSQLiteQueryable implements SqlDriverAdapter {
  async executeScript(script: string): Promise<void> {
    try {
      this.client.exec(script);
    } catch (e) {
      throw new DriverAdapterError(convertDriverError(e));
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (isolationLevel && isolationLevel !== 'SERIALIZABLE') {
      throw new DriverAdapterError({ kind: 'InvalidIsolationLevel', level: isolationLevel });
    }
    this.client.exec('BEGIN');
    return new NodeSQLiteTransaction(
      this.client,
      { usePhantomQuery: false },
      this.adapterOptions,
    );
  }

  getConnectionInfo(): ConnectionInfo {
    return { supportsRelationJoins: false };
  }

  async dispose(): Promise<void> {
    try {
      this.client.close();
    } catch {
      // Already closed — disposing is idempotent.
    }
  }
}

/**
 * Creates Prisma driver adapters backed by `node:sqlite`.
 * Pass it to `new PrismaClient({ adapter })`.
 */
export class MatrixNodeSQLiteAdapterFactory implements SqlDriverAdapterFactory {
  readonly provider = PROVIDER;
  readonly adapterName = ADAPTER_NAME;

  constructor(
    // A function is accepted so the URL can be resolved LAZILY, at connect
    // time. Prisma's own client reads process.env.DATABASE_URL when it
    // connects; tests (tests/setup.ts) set DATABASE_URL after module import,
    // so resolving eagerly at import would open the wrong database file.
    private readonly config: { url: string | (() => string) },
    private readonly options?: AdapterOptions,
  ) {}

  private resolveUrl(): string {
    return typeof this.config.url === 'function' ? this.config.url() : this.config.url;
  }

  async connect(): Promise<SqlDriverAdapter> {
    return new NodeSQLiteAdapter(this.open(this.resolveUrl()), this.options);
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    const url = (this.options as { shadowDatabaseUrl?: string } | undefined)?.shadowDatabaseUrl;
    return new NodeSQLiteAdapter(this.open(url ?? ':memory:'), this.options);
  }

  private open(url: string): DatabaseSync {
    const db = new DatabaseSync(url.replace(/^file:/, ''));
    // WAL + busy_timeout keep the API responsive under concurrent requests;
    // foreign_keys ON matches Prisma's default enforcement.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
}
