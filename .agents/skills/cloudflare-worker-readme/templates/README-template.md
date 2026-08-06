# {WORKER_NAME}

{WORKER_DESCRIPTION}

## Overview

`{worker-name}` is a **{worker-type}** that {main-functionality}.

{Overview details - explain what the worker does in more detail}

{Optional: Pipeline diagram}
```
{pipeline-diagram}
```

## Business Logic

### Message Flow

{Message flow description - numbered list of processing steps}

{Optional: Layer descriptions for multi-layer processing}

### {Layer/Processing Step Name}

{Detailed description of this processing layer/step}:

- **Purpose**: {what it does}
- **Input**: {what it receives}
- **Output**: {what it produces}
- **Key Operations**:
  {List of operations}

{Repeat for each layer/step}

{Optional: Gating Logic section}

## Queue Message Contracts

### Input Message

```typescript
{Input message interface}
```

{Optional: Field descriptions}

| Field | Type | Description |
|-------|------|-------------|
| {field} | {type} | {description} |

### Output Actions

- **ack**: Message processed successfully
- **retry**: Transient failure, message will be retried (up to {max-retries} times)

{Optional: Output message interface if applicable}

## Service Bindings

### Cloudflare Infrastructure

| Binding Type | Name | Purpose |
|-------------|------|---------|
| {binding-type} | {binding-name} | {purpose} |

### External Service Dependencies

| Service | Endpoint | Purpose |
|---------|----------|---------|
| {service-name} | `{HTTP_METHOD} {endpoint}` | {purpose} |

## Configuration

### wrangler.toml

```toml
{wrangler-configuration}
```

### Environment Variables

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `{VAR_NAME}` | `{default}` | {description} | {required} |

## {Optional Sections}

{Include sections as needed based on worker type}

### Event Types / Classification Schemes

{If the worker classifies data into types/categories}

| Type | Description |
|------|-------------|
| `{type}` | {description} |

### AI Model & Prompts

{For AI-powered workers}

- **Provider**: {provider-name}
- **Model**: {model-name} (configurable via `{MODEL_VAR}`)
- **Timeout**: {timeout}ms (configurable via `{TIMEOUT_VAR}`)
- **Temperature**: {temperature}
- **Response Format**: {format}

#### Prompts

{List of prompts used}

### Error Handling

#### Retryable Errors

- {List retryable error types}

#### Non-Retryable Errors

- {List non-retryable error types}

#### Processing Failure Recording

{Describe how failures are recorded}

```typescript
{ProcessingFailurePayload interface if applicable}
```

### Performance Considerations

#### Cost Optimization

- {Cost optimization strategies}

#### Processing Optimization

- {Processing optimization strategies}

### Security Considerations

- {Security measures and considerations}

## Data Flow Summary

```mermaid
{mermaid-diagram}
```

## Project Structure

```
{project-structure-tree}
```

## Dependencies

### npm Packages

{List of npm dependencies}

### Shared Utilities

{List of shared utilities from cf_workers/common/}

## Testing

{Testing instructions and commands}

```bash
{test-commands}
```

## Deployment

```bash
{deployment-commands}
```

## Monitoring & Observability

{Observability configuration and features}

## Integration with Other Services

### Upstream: {upstream-worker}

{Description of upstream integration}

```mermaid
{upstream-downstream-diagram}
```

### Downstream: {downstream-service}

{Description of downstream integration}

## Version History

- **{version}**: {description}

## Related Workers

- [{related-worker}](../{related-worker}/) — {description}

## Related Backend Code

{List of related backend files and their purposes}
