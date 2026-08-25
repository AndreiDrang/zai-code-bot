# Service Bindings Templates

Use these templates for documenting Cloudflare infrastructure bindings and external service dependencies.

## Basic Service Bindings Section

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type   | Name            | Purpose                                  |
| -------------- | --------------- | ---------------------------------------- |
| Queue Consumer | `{queue-name}`  | Trigger: receives messages to process    |
| Queue Producer | `{queue-name}`  | Sends messages for downstream processing |
| Secret Store   | `{secret-name}` | {description}                            |
| KV Namespace   | `{kv-name}`     | {description}                            |
| Durable Object | `{do-name}`     | {description}                            |
| R2 Bucket      | `{bucket-name}` | {description}                            |

### External Service Dependencies

| Service        | Endpoint                   | Purpose       |
| -------------- | -------------------------- | ------------- |
| {Service Name} | `{HTTP_METHOD} {endpoint}` | {description} |
| {Service Name} | `{HTTP_METHOD} {endpoint}` | {description} |
```

## Example: Queue Worker with Secrets

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type   | Name                        | Purpose                               |
| -------------- | --------------------------- | ------------------------------------- |
| Queue Consumer | `tb-news-raw-article-saved` | Trigger: receives messages to process |
| Secret Store   | `TB_API_TOKEN`              | Backend API authentication            |
| Secret Store   | `MISTRAL_API_KEY`           | Mistral AI API authentication         |

### External Service Dependencies

| Service          | Endpoint                                                       | Purpose                       |
| ---------------- | -------------------------------------------------------------- | ----------------------------- |
| TokenBel Backend | `GET /api/internal/news/raw-articles/{id}`                     | Fetch raw article content     |
| TokenBel Backend | `POST /api/internal/news/raw-articles/{id}/analysis`           | Save AI analysis results      |
| TokenBel Backend | `POST /api/internal/news/raw-articles/{id}/processing-failure` | Record processing failures    |
| Mistral AI       | `POST https://api.mistral.ai/v1/chat/completions`              | AI analysis (chat completion) |
```

## Example: Worker with Multiple Queues

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type   | Name             | Purpose                            |
| -------------- | ---------------- | ---------------------------------- |
| Queue Consumer | `tb-data-input`  | Receives data for processing       |
| Queue Producer | `tb-data-output` | Sends processed data to next stage |
| Queue Producer | `tb-data-errors` | Sends failed items for retry       |
| Secret Store   | `API_TOKEN`      | Backend authentication             |
| KV Namespace   | `tb-cache`       | Caches frequently accessed data    |

### External Service Dependencies

| Service       | Endpoint                 | Purpose              |
| ------------- | ------------------------ | -------------------- |
| Backend API   | `GET /api/data/{id}`     | Fetch data by ID     |
| Backend API   | `POST /api/data/process` | Save processed data  |
| Cache Service | `GET /cache/{key}`       | Retrieve cached data |
| Cache Service | `POST /cache/{key}`      | Store data in cache  |
```

## Example: Scheduled Worker

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type | Name        | Purpose                  |
| ------------ | ----------- | ------------------------ |
| Cron Trigger | `0 * * * *` | Runs every hour          |
| Secret Store | `API_TOKEN` | Backend authentication   |
| KV Namespace | `tb-stats`  | Stores hourly statistics |

### External Service Dependencies

| Service     | Endpoint                               | Purpose                             |
| ----------- | -------------------------------------- | ----------------------------------- |
| Backend API | `GET /api/statistics?period=last_hour` | Fetch recent statistics             |
| Backend API | `POST /api/statistics/hourly`          | Save aggregated hourly stats        |
| Webhook     | `POST {WEBHOOK_URL}`                   | Send alerts for critical conditions |
```

## Example: Worker with R2 Storage

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type   | Name                | Purpose                           |
| -------------- | ------------------- | --------------------------------- |
| Queue Consumer | `tb-file-processor` | Receives file processing requests |
| R2 Bucket      | `tb-uploads`        | Stores uploaded files             |
| R2 Bucket      | `tb-processed`      | Stores processed files            |
| Secret Store   | `R2_ACCESS_KEY`     | R2 access credentials             |
| Secret Store   | `R2_SECRET_KEY`     | R2 secret credentials             |

### External Service Dependencies

| Service      | Endpoint                               | Purpose                           |
| ------------ | -------------------------------------- | --------------------------------- |
| Backend API  | `GET /api/files/{id}/metadata`         | Fetch file metadata               |
| Backend API  | `POST /api/files/{id}/processed`       | Mark file as processed            |
| External API | `POST https://api.example.com/process` | Send file for external processing |
```

## Example: Worker with Durable Objects

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type   | Name                | Purpose                 |
| -------------- | ------------------- | ----------------------- |
| Queue Consumer | `tb-session-events` | Receives session events |
| Durable Object | `SessionManager`    | Manages user sessions   |
| Durable Object | `Counter`           | Tracks metrics          |
| Secret Store   | `SESSION_SECRET`    | Session encryption key  |

### External Service Dependencies

| Service           | Endpoint                                   | Purpose             |
| ----------------- | ------------------------------------------ | ------------------- |
| Backend API       | `POST /api/sessions/events`                | Save session events |
| Analytics Service | `POST https://analytics.example.com/track` | Track user behavior |
```

## Template with All Binding Types

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type    | Name             | Purpose       | Configuration                                      |
| --------------- | ---------------- | ------------- | -------------------------------------------------- |
| Queue Consumer  | `{queue-name}`   | {description} | `max_batch_size = {size}, max_retries = {retries}` |
| Queue Producer  | `{queue-name}`   | {description} | -                                                  |
| Secret Store    | `{secret-name}`  | {description} | `store_id = {id}, secret_name = {name}`            |
| KV Namespace    | `{kv-name}`      | {description} | `binding = {binding}, id = {id}`                   |
| Durable Object  | `{do-name}`      | {description} | `class_name = {class}, binding = {binding}`        |
| R2 Bucket       | `{bucket-name}`  | {description} | `binding = {binding}, bucket_name = {name}`        |
| Cron Trigger    | `{schedule}`     | {description} | `cron = "{cron-expression}"`                       |
| Service Binding | `{service-name}` | {description} | `service = {service}, binding = {binding}`         |

### External Service Dependencies

| Service        | Endpoint                   | Purpose       | Authentication |
| -------------- | -------------------------- | ------------- | -------------- |
| {Service Name} | `{HTTP_METHOD} {endpoint}` | {description} | {auth-method}  |
| {Service Name} | `{HTTP_METHOD} {endpoint}` | {description} | {auth-method}  |
```

## wrangler.toml Configuration Template

````markdown
## Configuration (wrangler.toml)

```toml
# Queue Consumer
[[queues.consumers]]
queue = "{queue-name}"
max_batch_size = {batch-size}
max_retries = {max-retries}
max_batch_timeout = {timeout}

# Queue Producer (if applicable)
[[queues.producers]]
queue = "{queue-name}"
binding = "{binding-name}"

# Secrets
[[secrets_store_secrets]]
binding = "{SECRET_BINDING}"
store_id = "{store-id}"
secret_name = "{secret-name}"

# KV Namespace
[[kv_namespaces]]
binding = "{KV_BINDING}"
id = "{kv-id}"

# R2 Bucket
[[r2_buckets]]
binding = "{R2_BINDING}"
bucket_name = "{bucket-name}"

# Durable Object
[[durable_objects]]
name = "{DO_NAME}"
class_name = "{ClassName}"

# Environment Variables
[vars]
VARIABLE_NAME = "{default-value}"
ANOTHER_VAR = "{default-value}"

# Cron Trigger (for scheduled workers)
[triggers]
crons = ["{cron-expression}"]
```
````

````

## Environment Variables Table Template

```markdown
## Configuration

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `API_DOMAIN` | `https://dashboard.tokenbel.info` | Backend API base URL | Yes |
| `MISTRAL_API_KEY` | (secret) | Mistral AI API key | Yes |
| `MISTRAL_CHAT_MODEL` | `mistral-small-latest` | Mistral model to use | No |
| `MISTRAL_CHAT_TIMEOUT_MS` | `120000` | Mistral request timeout (ms) | No |
| `ARTICLE_TEXT_MAX_CHARS` | `50000` | Max characters sent to AI | No |
| `PROMPT_VERSION` | `news-event-v5` | Prompt version identifier | No |
````

## Best Practices for Service Bindings

1. **Group by type**: Separate Cloudflare infrastructure from external services
2. **Be specific**: Include HTTP methods and full endpoints
3. **Describe purpose**: Explain what each binding/service is used for
4. **Include configuration**: Show relevant wrangler.toml configuration
5. **Document secrets**: List all required secrets and their purpose
6. **Show defaults**: Include default values for configurable variables
7. **Mark required**: Indicate which variables are required vs optional
8. **Link to docs**: Add links to external service documentation when helpful

## Common Patterns

### Queue Worker Pattern

```markdown
### Cloudflare Infrastructure

| Binding Type   | Name            | Purpose                          |
| -------------- | --------------- | -------------------------------- |
| Queue Consumer | `{input-queue}` | Receives messages for processing |
| Secret Store   | `API_TOKEN`     | Backend authentication           |

### External Service Dependencies

| Service | Endpoint                        | Purpose      |
| ------- | ------------------------------- | ------------ |
| Backend | `GET /api/data/{id}`            | Fetch data   |
| Backend | `POST /api/data/{id}/processed` | Save results |
```

### AI Worker Pattern

```markdown
### Cloudflare Infrastructure

| Binding Type   | Name            | Purpose                             |
| -------------- | --------------- | ----------------------------------- |
| Queue Consumer | `{input-queue}` | Receives messages for AI processing |
| Secret Store   | `API_TOKEN`     | Backend authentication              |
| Secret Store   | `AI_API_KEY`    | AI provider API key                 |

### External Service Dependencies

| Service     | Endpoint                                | Purpose                 |
| ----------- | --------------------------------------- | ----------------------- |
| Backend     | `GET /api/data/{id}`                    | Fetch data for analysis |
| Backend     | `POST /api/data/{id}/analysis`          | Save AI results         |
| AI Provider | `POST https://api.provider.com/v1/chat` | AI analysis endpoint    |
```

### API Worker Pattern

```markdown
### Cloudflare Infrastructure

| Binding Type | Name              | Purpose               |
| ------------ | ----------------- | --------------------- |
| HTTP Route   | `/api/{endpoint}` | Handles HTTP requests |
| Secret Store | `API_TOKEN`       | Authentication token  |
| KV Namespace | `cache`           | Response caching      |

### External Service Dependencies

| Service  | Endpoint         | Purpose     |
| -------- | ---------------- | ----------- |
| Database | `GET /data/{id}` | Fetch data  |
| Database | `POST /data`     | Create data |
```
