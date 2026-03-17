export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiMessage: string,
    public readonly errors?: Record<string, string[]>
  ) {
    super(`API error ${status}: ${apiMessage}`);
    this.name = "ApiError";
  }

  toToolResult(): string {
    switch (this.status) {
      case 401:
        return "Authentication failed. The API token may be invalid or revoked.";
      case 409:
        return "This review already has a published response.";
      case 429:
        return "Rate limit exceeded. The API allows 60 requests per minute. Please wait before retrying.";
      default: {
        let msg = `Error ${this.status}: ${this.apiMessage}`;
        if (this.errors) {
          const details = Object.entries(this.errors)
            .map(([field, messages]) => `  ${field}: ${messages.join(", ")}`)
            .join("\n");
          msg += `\nValidation errors:\n${details}`;
        }
        return msg;
      }
    }
  }
}

interface RequestOptions {
  appUuid?: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: Record<string, unknown>;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(token: string, baseUrl: string = "https://app.upratehq.com") {
    this.token = token;
    this.baseUrl = `${baseUrl}/api/v1`;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(`${key}[]`, item);
          }
        } else {
          url.searchParams.set(key, String(value));
        }
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
    if (appUuid) {
      headers["Uprate-App-Id"] = appUuid;
    }
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.appUuid);

    const fetchOptions: RequestInit = { method, headers };
    if (options.body && (method === "POST" || method === "PATCH")) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({
        message: response.statusText,
      })) as { message?: string; errors?: Record<string, string[]> };
      throw new ApiError(
        response.status,
        errorBody.message ?? response.statusText,
        errorBody.errors
      );
    }

    return (await response.json()) as T;
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  async post<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, options);
  }

  async patch<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }
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
