export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiMessage: string,
    public readonly errors?: Record<string, string[]>,
    public readonly code?: string,
    public readonly retryAfter?: string
  ) {
    super(`API error ${status}: ${apiMessage}`);
    this.name = "ApiError";
  }

  toToolResult(): string {
    if (this.status === 401) {
      return "Authentication failed. The API token may be invalid or revoked.";
    }

    if (this.status === 429) {
      const retry = this.retryAfter
        ? ` Retry after ${this.retryAfter} seconds.`
        : " Please wait before retrying.";
      return `Rate limit exceeded. The API allows 300 requests per minute.${retry}`;
    }

    const label = this.code ? ` (${this.code})` : "";
    let message = `Error ${this.status}${label}: ${this.apiMessage}`;
    if (this.errors) {
      const details = Object.entries(this.errors)
        .map(([field, messages]) => `  ${field}: ${messages.join(", ")}`)
        .join("\n");
      message += `\nValidation errors:\n${details}`;
    }
    return message;
  }
}

export interface RequestOptions {
  appUuid?: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: Record<string, unknown>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class ApiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    baseUrl: string = "https://app.upratehq.com"
  ) {
    this.baseUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(appUuid?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (appUuid) headers["Uprate-App-Id"] = appUuid;
    return headers;
  }

  private async request<T>(
    method: Method,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const fetchOptions: RequestInit = {
      method,
      headers: this.buildHeaders(options.appUuid),
    };
    // A timed-out mutation may still finish upstream. Only abort safe reads so
    // callers never receive a retryable-looking failure for an unknown write.
    if (method === "GET") fetchOptions.signal = AbortSignal.timeout(10_000);
    if (options.body && ["POST", "PATCH", "PUT"].includes(method)) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(this.buildUrl(path, options.query), fetchOptions);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        errors?: Record<string, string[]>;
      };
      throw new ApiError(
        response.status,
        body.message ?? body.error ?? response.statusText,
        body.errors,
        body.error,
        response.headers.get("Retry-After") ?? undefined
      );
    }

    if (response.status === 204) return null as T;
    return (await response.json()) as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("GET", path, options);
  }

  post<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("POST", path, options);
  }

  patch<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("PATCH", path, options);
  }

  put<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("PUT", path, options);
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request("DELETE", path, options);
  }
}

export function jsonToolResult(value: unknown) {
  const structuredContent =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

export function handleToolError(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const message =
    error instanceof ApiError
      ? error.toToolResult()
      : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}
