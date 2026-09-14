/**
 * Shared types for xdb.js. Frozen contract: every module imports from here.
 * Do not change a type in this file without updating CONTRACTS.md.
 */

/** The name of an XDB value type. Same names as the Go library. */
export type ValueType =
  | 'string'
  | 'integer'
  | 'unsigned'
  | 'float'
  | 'boolean'
  | 'time'
  | 'json'
  | 'bytes'
  | 'array'

/** A value that a tuple can hold. */
export type TupleValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | JSONValue
  | TupleValue[]

export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue }

/**
 * A tuple is an attribute value at a record path.
 * `path` is `ns/schema/id`, without the `xdb://` prefix.
 * `attr` uses dots for nested names, for example `author.name`.
 */
export interface Tuple {
  path: string
  attr: string
  value: TupleValue
  /** The declared or inferred type. Absent means "infer on demand". */
  type?: ValueType
  /** The element type, when `type` is 'array'. */
  items?: ValueType
}

/** A tuple on input. The array form is `[path, attr, value]`. */
export type TupleInput = Tuple | [string, string, TupleValue]

/** The four write ops. Same table as the Go driver contract. */
export type Op = 'create' | 'put' | 'patch' | 'delete'

/** One write against one record path. */
export interface Mutation {
  path: string
  op: Op
  /** Puts, for 'create' | 'put' | 'patch'. */
  tuples?: Tuple[]
  /** Removals, for 'delete'. Empty or absent means the whole record. */
  attrs?: string[]
  /** Optimistic-concurrency precondition. 0 or absent writes unconditionally. */
  version?: number
}

/** A parsed `xdb://ns/schema/id#attr` URI. Every part after ns is optional. */
export interface URI {
  ns: string
  schema?: string
  id?: string
  attr?: string
}

/** Schema modes. The mode governs undeclared fields only. */
export type SchemaMode = 'strict' | 'flexible' | 'dynamic'

/** One declared field of a schema. */
export interface Field {
  type: ValueType
  /** The element type, when `type` is 'array'. */
  items?: ValueType
  required?: boolean
  indexed?: boolean
  unique?: boolean
}

/** A schema definition. `ns/schema` is its path. */
export interface Def {
  ns: string
  schema: string
  mode: SchemaMode
  fields: Record<string, Field>
  revision?: number
}

/** A list query against the tuple layer. */
export interface Query {
  /** Scope: `ns` or `ns/schema`. */
  scope: string
  /** Keeps a record when the predicate returns true. */
  filter?: (record: RecordObject) => boolean
  fields?: string[]
  limit?: number
  offset?: number
}

export interface Page<T> {
  items: T[]
  total: number
  /** 0 means no more pages. */
  nextOffset: number
}

/** Storage. A driver stores tuples and definitions. It does no validation. */
export interface Driver {
  getTuples(uris: string[]): Promise<Tuple[]>
  /** Yields every tuple under a scope. The tuples of one record are contiguous. */
  scanTuples(scope: string): AsyncIterable<Tuple>
  /** Applies one mutation atomically. */
  apply(m: Mutation): Promise<void>

  getSchema(path: string): Promise<Def | null>
  scanSchemas(scope: string): AsyncIterable<Def>
  createSchema(def: Def): Promise<void>
  putSchema(def: Def): Promise<void>
  deleteSchema(path: string): Promise<void>
  dropRecords(path: string): Promise<void>

  tx?(fn: (t: Driver) => Promise<void>): Promise<void>
  queryTuples?(q: Query): Promise<Page<Tuple[]>>
  close?(): Promise<void>
}

/** A plain record object, as a collection or `records.get` returns it. */
export type RecordObject = Record<string, unknown>

/** A change event, in the shape of `xdb watch`. */
export interface WatchEvent {
  type: 'put' | 'delete'
  uri: string
  attrs: string[]
  version: number
}

export type Unsubscribe = () => void

// ---- query engine ----

/** Variable bindings during a pattern run. Keys include the leading '?'. */
export type Context = Record<string, unknown>

/**
 * A pattern slot. A string that starts with '?' is a variable.
 * Any other value is a constant.
 */
export type Slot = string | TupleValue

/**
 * The path slot of a pattern. Three forms:
 *   'ns/schema/id'  a constant path, matches one record
 *   'ns/schema/?v'  matches every record of that schema, binds ?v to the id
 *   '?v'            matches any record, binds ?v to the full path
 */
export type PathSlot = string

/** `[path, attr, value]`. An attr constant that ends in '.*' matches a prefix. */
export type Pattern = [PathSlot, string, Slot]

/**
 * One entry of a `where` list:
 *   Pattern                  a required match
 *   { opt: Pattern }         an optional match, keeps the context when nothing matches
 *   { optAll: Pattern[] }    all of these match, or none of them binds. This is
 *                            the left-join primitive: an alias joins as a whole,
 *                            so a record that fails one condition contributes
 *                            nothing rather than a partly bound row.
 *   string                   a predicate over bound variables, '?a > 3' or '?a == ?b'
 *   (ctx) => boolean         a compiled predicate
 */
export type WhereClause =
  | Pattern
  | { opt: Pattern }
  | { optAll: Pattern[] }
  | string
  | ((ctx: Context) => boolean)

export interface PatternQuery {
  find: string[]
  where: WhereClause[]
}

/** A `schema|attr` key. '*' in either position is a wildcard. */
export type ChangeKey = string

// ---- live queries ----

export interface LiveQuery<T> {
  toArray(): T[]
  subscribe(cb: (rows: T[]) => void): Unsubscribe
}

/** The handle a collection mutation returns. */
export interface MutationTx {
  /** Resolves after the driver and the sync source accept the write. */
  isPersisted: { promise: Promise<void> }
  mutations: Mutation[]
}

// ---- sync ----

export interface SyncChange {
  path: string
  attr: string
  value?: TupleValue
  deleted?: boolean
  version: number
}

export interface SyncContext {
  begin(): void
  write(change: SyncChange): void
  commit(): void
}

export interface SyncSource {
  /** Starts the pull side. Returns a function that stops it. */
  start(ctx: SyncContext): Unsubscribe
  /** Pushes local mutations. A rejection rolls them back. */
  push(mutations: Mutation[]): Promise<void>
}
