/** Error codes. The Go catalog, plus VALIDATION for a schema parse failure. */
export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'SCHEMA_VIOLATION'
  | 'CONFLICT'
  | 'INVALID_QUERY'
  | 'INVALID_URI'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED'

export interface XDBErrorInfo {
  code: ErrorCode
  message: string
  uri?: string
  action?: string
  /** Field-level detail, for VALIDATION and SCHEMA_VIOLATION. */
  issues?: { path: string; message: string }[]
  cause?: unknown
}

/** Every error that xdb.js throws. The shape matches the CLI error shape. */
export class XDBError extends Error {
  readonly code: ErrorCode
  readonly uri?: string
  readonly action?: string
  readonly issues?: { path: string; message: string }[]

  constructor(info: XDBErrorInfo) {
    super(info.message, info.cause !== undefined ? { cause: info.cause } : undefined)
    this.name = 'XDBError'
    this.code = info.code
    this.uri = info.uri
    this.action = info.action
    this.issues = info.issues
  }

  toJSON() {
    return { code: this.code, message: this.message, uri: this.uri, action: this.action, issues: this.issues }
  }
}

/** True when `e` is an XDBError, and when `code` is given, of that code. */
export function isXDBError(e: unknown, code?: ErrorCode): e is XDBError {
  return e instanceof XDBError && (code === undefined || e.code === code)
}

const make = (code: ErrorCode) => (message: string, info: Partial<XDBErrorInfo> = {}) =>
  new XDBError({ ...info, code, message })

export const validation = make('VALIDATION')
export const notFound = make('NOT_FOUND')
export const alreadyExists = make('ALREADY_EXISTS')
export const schemaViolation = make('SCHEMA_VIOLATION')
export const conflict = make('CONFLICT')
export const invalidQuery = make('INVALID_QUERY')
export const invalidURI = make('INVALID_URI')
export const unavailable = make('UNAVAILABLE')
export const unsupported = make('UNSUPPORTED')
