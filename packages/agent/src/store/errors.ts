export type StoreErrorCode = "STORE_BAD_INPUT" | "STORE_UNAVAILABLE";

// Fixed text per code. A driver error carries the SQL text, the bound values
// and sometimes the connection target, so none of it is ever copied in (C3.6).
const MESSAGES: Record<StoreErrorCode, string> = {
  STORE_BAD_INPUT: "The store refused an input outside its limits.",
  STORE_UNAVAILABLE: "The database could not complete the request.",
};

/**
 * The only error type the store throws. It never carries a `cause`, because
 * the driver error underneath holds the query and its parameters.
 */
export class StoreError extends Error {
  override readonly name = "StoreError";
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
