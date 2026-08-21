export class AuthRequiredError extends Error {
  constructor(message = "authentication required") {
    super(message);
    this.name = "AuthRequiredError";
    this.code = "auth-required";
  }
}

export class AuthSession {
  #token = null;
  #account = null;

  get authenticated() { return this.#token !== null; }
  get account() { return this.#account; }

  setLogin(result) {
    if (!result || typeof result.access_token !== "string" || result.access_token.length === 0) {
      throw new Error("login response is missing access_token");
    }
    if (result.token_type !== undefined && String(result.token_type).toLowerCase() !== "bearer") {
      throw new Error(`unsupported token type: ${result.token_type}`);
    }
    this.#token = result.access_token;
    this.#account = result.account ?? null;
  }

  clear() {
    this.#token = null;
    this.#account = null;
  }

  authorization() {
    if (this.#token === null) throw new AuthRequiredError();
    return `Bearer ${this.#token}`;
  }
}
