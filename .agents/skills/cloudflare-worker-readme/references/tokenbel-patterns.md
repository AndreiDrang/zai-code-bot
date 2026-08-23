# TokenBel Cloudflare Worker Patterns

This document describes the established patterns and conventions used in TokenBel Cloudflare Workers, based on analysis of existing Workers like `tb-news-ai-analyzer`.

## Project Structure Pattern

All TokenBel Workers follow a consistent project structure:

```
cf_workers/{worker-name}/
├── src/
│   ├── {worker-name}-worker.ts    # Main queue handler
│   ├── *.ts                        # Helper modules
│   └── generated/
│       └── *.ts                   # Generated code (prompts, etc.)
├── scripts/
│   └── *.mjs                      # Build/generation scripts
├── prompts/
│   └── *.txt                      # Prompt source files
├── tests/
│   └── *.test.ts                  # Vitest tests
├── wrangler.toml                  # Cloudflare Workers configuration
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── deploy.sh
```

## Naming Conventions

### Worker Names
- Prefix: `tb-` (TokenBel)
- Format: `tb-{category}-{function}`
- Examples:
  - `tb-news-ai-analyzer` - News AI analysis
  - `tb-news-article-extractor` - News article extraction
  - `tb-finstore-primary-market-sync` - FinStore primary market sync
  - `tb-fainex-second-market` - Fainex secondary market

### File Names
- Main worker file: `{worker-name}-worker.ts`
- Helper files: Descriptive names with `-` separator
- Test files: `{module}.test.ts`

### Queue Names
- Prefix: `tb-`
- Format: `tb-{category}-{action}-{state}`
- Examples:
  - `tb-news-articles-discovered`
  - `tb-news-raw-article-saved`
  - `tb-news-ai-analysis-completed`

## Configuration Patterns

### wrangler.toml Structure

```toml
# Queue Consumer Configuration
[[queues.consumers]]
queue = "{queue-name}"
max_batch_size = 1  # Typically 1 for sequential processing
max_retries = 3     # Standard retry count

# Secrets Configuration
[[secrets_store_secrets]]
binding = "TB_API_TOKEN"
store_id = "{store-id}"
secret_name = "TBel-API-Token"

# Environment Variables
[vars]
API_DOMAIN = "https://dashboard.tokenbel.info"
# Worker-specific variables follow

# Compatibility flags
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]
```

### Common Environment Variables

| Variable | Default | Description | Used In |
|----------|---------|-------------|---------|
| `API_DOMAIN` | `https://dashboard.tokenbel.info` | Backend API base URL | All Workers |
| `TB_API_TOKEN` | (secret) | Backend API authentication | All Workers |

### AI Worker Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROMPT_VERSION` | `news-event-v5` | Prompt version identifier |
| `MISTRAL_API_KEY` | (secret) | Mistral AI API key |
| `MISTRAL_CHAT_MODEL` | `mistral-small-latest` | Mistral model to use |
| `MISTRAL_CHAT_TIMEOUT_MS` | `120000` | Mistral request timeout (ms) |
| `ARTICLE_TEXT_MAX_CHARS` | `50000` | Max characters sent to AI |

## Code Patterns

### Main Worker Structure

```typescript
// Main worker entry point
export default {
  queue: async (batch: QueueBatch, env: Env, ctx: ExecutionContext) => {
    // Process each message in the batch
    for (const message of batch.messages) {
      await processMessage(message, env, ctx);
    }
  },
} satisfies ExportedHandler<Env>;
```

### Message Processing Pattern

```typescript
async function processMessage(message: QueueMessage, env: Env, ctx: ExecutionContext) {
  try {
    // 1. Validate environment
    const validatedEnv = validateEnv(env);
    
    // 2. Parse and validate message
    const parsedMessage = parseMessage(message);
    
    // 3. Fetch required data
    const data = await fetchData(parsedMessage, validatedEnv);
    
    // 4. Process data through pipeline
    const result = await processData(data, validatedEnv);
    
    // 5. Save results
    await saveResults(result, validatedEnv);
    
    // 6. Ack message
    message.ack();
  } catch (error) {
    handleError(error, message, env);
  }
}
```

### Environment Validation

```typescript
// env.ts
import { z } from "zod";

export const EnvSchema = z.object({
  TB_API_TOKEN: z.string(),
  API_DOMAIN: z.string().url(),
  MISTRAL_API_KEY: z.string().optional(),
  // ... other env vars
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(env: unknown): Env {
  return EnvSchema.parse(env);
}

// Resolve secrets at runtime
export async function resolveSecrets(env: Env): Promise<ResolvedEnv> {
  return {
    ...env,
    TB_API_TOKEN: await resolveSecretValue(env.TB_API_TOKEN),
    MISTRAL_API_KEY: env.MISTRAL_API_KEY 
      ? await resolveSecretValue(env.MISTRAL_API_KEY)
      : undefined,
  };
}
```

### Backend API Client Pattern

```typescript
// backend-client.ts
import { WorkerLogger } from "cf_workers/common/logger";

const logger = new WorkerLogger("backend-client");

export class BackendClient {
  private readonly apiToken: string;
  private readonly apiDomain: string;

  constructor(apiToken: string, apiDomain: string) {
    this.apiToken = apiToken;
    this.apiDomain = apiDomain;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.apiDomain}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      "X-API-Token": this.apiToken,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Backend API error", {
        status: response.status,
        endpoint,
        error: errorText,
      });
      throw new Error(`Backend API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async getRawArticle(id: number) {
    return this.request<RawArticle>("GET", `/api/internal/news/raw-articles/${id}`);
  }

  async saveAnalysis(id: number, analysis: AnalysisPayload) {
    return this.request<void>("POST", `/api/internal/news/raw-articles/${id}/analysis`, analysis);
  }

  async recordProcessingFailure(id: number, failure: ProcessingFailurePayload) {
    return this.request<void>("POST", `/api/internal/news/raw-articles/${id}/processing-failure`, failure);
  }
}
```

### Error Handling Pattern

```typescript
// types.ts
export interface ProcessingFailurePayload {
  stage: string;                    // 'fetch_raw_article', 'validate_raw_article', etc.
  reason: string;                   // Human-readable error description
  retryable: boolean;               // false for recorded failures
  details?: Record<string, unknown>; // Additional context
}

// Error handling function
export function handleError(
  error: unknown,
  message: QueueMessage,
  env: Env
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  // Determine if error is retryable
  const isRetryable = isRetryableError(error);
  
  if (isRetryable) {
    // Transient error - will be retried
    logger.warn("Retryable error", { error: errorMessage });
    throw error; // Re-throw to trigger retry
  } else {
    // Non-retryable error - record and ack
    logger.error("Non-retryable error", { error: errorMessage });
    
    // Extract message info for failure recording
    const messageInfo = extractMessageInfo(message);
    
    // Record failure in backend
    const failurePayload: ProcessingFailurePayload = {
      stage: determineFailureStage(error),
      reason: errorMessage,
      retryable: false,
      details: { ...messageInfo, error: errorMessage },
    };
    
    // Ack the message to prevent poison queue
    message.ack();
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Network errors, timeouts, 5xx errors are retryable
    return (
      error.name === "FetchError" ||
      error.name === "TimeoutError" ||
      error.message.includes("50") ||
      error.message.includes("429") // Rate limiting
    );
  }
  return false;
}
```

### Logging Pattern

```typescript
// Using shared logger
import { WorkerLogger } from "cf_workers/common/logger";

const logger = new WorkerLogger("worker-name");

// Structured logging
logger.info("Processing started", {
  messageId: message.id,
  rawArticleId: parsedMessage.raw_article_id,
});

logger.debug("Layer 1 screening result", {
  isRelevant: result.is_relevant,
  relevanceScore: result.relevance_score,
  categories: result.relevance_categories,
});

logger.warn("Content hash mismatch", {
  expectedHash: message.content_hash,
  actualHash: article.content_hash,
});

logger.error("Processing failed", {
  stage: "layer1_screening",
  error: error.message,
  details: { ...context },
});
```

## Multi-Layer Processing Pattern

Based on `tb-news-ai-analyzer`, this pattern is used for AI-powered Workers:

```
Layer 0: Cleaner (Fast, Deterministic)
    ↓
Layer 0.5: Prefilter (Fast, Rule-based)
    ↓
Layer 1: Screening (AI, Relevance Assessment)
    ↓
Layer 2.1: Fact Distillation (AI, Audit-only)
    ↓
Layer 2.2: Event Builder (AI, Final Extraction)
    ↓
Backend Persistence
```

### Layer 0: Cleaner

- **Purpose**: Text normalization before any analysis
- **Characteristics**: Fast, deterministic, CPU-only
- **Operations**:
  - Unicode normalization (NFKC)
  - Invisible character removal
  - Emoji removal
  - Case normalization
  - Punctuation normalization
  - Boilerplate removal
  - Lemma replacement

### Layer 0.5: Prefilter

- **Purpose**: Filter out irrelevant content before expensive AI calls
- **Characteristics**: Fast, rule-based, CPU-only
- **Operations**:
  - Minimum length check
  - Irrelevant pattern matching
  - Keyword presence check
- **Cost Savings**: Filters ~40-60% of articles before AI calls

### Layer 1: AI Screening

- **Purpose**: Determine if content is relevant for deep analysis
- **Characteristics**: AI-powered, moderate cost
- **Output**: Relevance score, categories, decision
- **Gating**: Only proceed if relevance >= threshold

### Layer 2: Deep Analysis

Split into two sub-layers for better separation:

#### Layer 2.1: Fact Distillation
- **Purpose**: Extract audit-only facts and context
- **Characteristics**: AI-powered, expensive
- **Output**: Facts, values, named objects, candidate hints
- **Usage**: Context for Layer 2.2, stored in audit trail only

#### Layer 2.2: Event Builder
- **Purpose**: Build final structured result
- **Characteristics**: AI-powered, expensive
- **Input**: Article + Layer 1 + Layer 2.1 context
- **Output**: Final event with all fields

## Testing Patterns

### Test Structure

```
tests/
├── {module}.test.ts          # Unit tests for each module
├── worker.test.ts            # Integration tests for main worker
└── fixtures/                 # Test fixtures
    └── *.json
```

### Test Setup

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import miniflare from "vitest-environment-miniflare";

export default defineConfig({
  test: {
    environment: miniflare({
      // Miniflare configuration
      queues: {
        "tb-test-queue": [],
      },
      secrets: {
        TB_API_TOKEN: "test-token",
      },
    }),
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
```

### Test Example

```typescript
// analyzer-runner.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAnalysisPipeline } from "../src/analyzer-runner";

describe("Analyzer Runner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject articles that fail prefilter", async () => {
    const mockArticle = {
      id: 1,
      raw_text: "Short text", // Will fail minimum length check
    };

    const result = await runAnalysisPipeline(mockArticle, mockEnv);

    expect(result.stage).toBe("layer0_5_prefilter");
    expect(result.retryable).toBe(false);
  });

  it("should proceed to Layer 1 for relevant articles", async () => {
    const mockArticle = {
      id: 1,
      raw_text: "This is a long enough article about financial topics...",
    };

    const result = await runAnalysisPipeline(mockArticle, mockEnv);

    expect(result.layer1Result).toBeDefined();
    expect(result.layer1Result.is_relevant).toBe(true);
  });
});
```

## Deployment Patterns

### deploy.sh Script

```bash
#!/bin/bash
set -e

# Build the worker
npm run build

# Deploy to Cloudflare
wrangler deploy

# Or with specific environment
echo "Deploying to $ENVIRONMENT"
wrangler deploy --env "$ENVIRONMENT"
```

### package.json Scripts

```json
{
  "scripts": {
    "build": "esbuild src/{worker-name}-worker.ts --outfile=dist/worker.js --format=esm --platform=node --bundle",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "generate:prompt": "node scripts/generate-prompt.mjs",
    "prebuild": "npm run generate:prompt"
  }
}
```

## Shared Utilities

TokenBel Workers use shared utilities from `cf_workers/common/`:

### Logger

```typescript
// cf_workers/common/logger.js
class WorkerLogger {
  constructor(namespace: string) {
    this.namespace = namespace;
  }

  info(message: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({
      level: "info",
      namespace: this.namespace,
      message,
      ...data,
      timestamp: new Date().toISOString(),
    }));
  }

  // error, warn, debug methods similar
}
```

### Utils

```typescript
// cf_workers/common/utils.js
export async function resolveSecretValue(secret: string | Secret): Promise<string> {
  if (typeof secret === "string") {
    return secret;
  }
  return secret.get();
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}
```

## Best Practices

### 1. Cost Optimization

- **Filter Early**: Use Layer 0.5 prefilter to avoid expensive AI calls
- **Batch Size**: Set `max_batch_size = 1` for sequential AI processing
- **Text Truncation**: Limit text size before AI calls
- **Caching**: Use KV for frequently accessed data

### 2. Error Handling

- **Distinguish Errors**: Separate retryable vs non-retryable errors
- **Record Failures**: Always record processing failures in backend
- **Ack on Failure**: Ack messages for non-retryable errors to prevent poison queue
- **Structured Errors**: Use consistent error formats

### 3. Observability

- **Structured Logging**: Use JSON logging with consistent fields
- **Metrics**: Track processing times, success rates, error rates
- **Traces**: Enable distributed tracing in wrangler.toml

### 4. Testing

- **Unit Tests**: Test each layer independently
- **Integration Tests**: Test full message processing flow
- **Mock External Services**: Use vitest mocks for external API calls
- **Coverage**: Aim for 80%+ test coverage

### 5. Documentation

- **README.md**: Always include comprehensive README
- **Mermaid Diagrams**: Use for complex workflows
- **Type Definitions**: Document all interfaces and types
- **Examples**: Include example messages and payloads

## Common Integrations

### Upstream Workers

Workers that produce messages consumed by others:
- `tb-news-article-extractor` → produces to `tb-news-raw-article-saved`
- `tb-data-collector` → produces to various data queues

### Downstream Services

Services that consume Worker outputs:
- TokenBel Backend API
- External AI providers (Mistral, etc.)
- Notification services (webhooks, email)
- Analytics services

### Backend API Endpoints

Common endpoints used by Workers:
- `GET /api/internal/news/raw-articles/{id}` - Fetch article
- `POST /api/internal/news/raw-articles/{id}/analysis` - Save analysis
- `POST /api/internal/news/raw-articles/{id}/processing-failure` - Record failure
- `GET /api/internal/data/{id}` - Fetch data
- `POST /api/internal/data/{id}/sync` - Save synced data
