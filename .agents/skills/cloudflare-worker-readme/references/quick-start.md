# Quick Start: Cloudflare Worker README Generator

This guide helps you quickly create a comprehensive README.md for any Cloudflare Worker in the TokenBel project.

## Step 1: Navigate to Worker Directory

```bash
cd /workspace/Red-Panda-Dev__tbel/cf_workers/{worker-name}
```

## Step 2: Gather Information

Collect the following information about your Worker:

### Required Information

1. **Worker Name** - from directory name
2. **Purpose** - what the Worker does
3. **Worker Type** - queue consumer, scheduled, HTTP, etc.
4. **Main Functionality** - brief description

### Configuration Information

5. **Queue Bindings** - from `wrangler.toml`
   - Consumer queues
   - Producer queues
   - max_batch_size
   - max_retries

6. **Secrets** - from `wrangler.toml`
   - Secret names
   - Store IDs
   - Purpose of each secret

7. **Environment Variables** - from `wrangler.toml` and code
   - Variable names
   - Default values
   - Descriptions
   - Required/optional

### Code Information

8. **Message Contracts** - from main worker file
   - Input message interface
   - Output message interface (if applicable)
   - Message version

9. **Processing Pipeline** - from main worker file
   - Processing steps
   - Layer descriptions (if multi-layer)
   - Decision points
   - Gating logic

10. **External Services** - from code
    - Service names
    - Endpoints (with HTTP methods)
    - Purpose of each call

11. **Project Structure** - from directory
    - File organization
    - Key files and their purposes

12. **Dependencies** - from `package.json`
    - npm packages
    - Shared utilities

## Step 3: Use Templates

### Option A: Start from Scratch

Create a new `README.md` file and use the templates as reference:

```bash
# Create README from template
cp /workspace/Red-Panda-Dev__tbel/.agents/skills/cloudflare-worker-readme/templates/README-template.md README.md

# Edit the file
vim README.md
```

### Option B: Copy from Similar Worker

Find a similar Worker and copy its README:

```bash
# List all Workers with README files
find /workspace/Red-Panda-Dev__tbel/cf_workers -name "README.md" -type f

# Copy from a similar Worker
cp /workspace/Red-Panda-Dev__tbel/cf_workers/tb-news-ai-analyzer/README.md README.md

# Edit the copied file
vim README.md
```

## Step 4: Fill in Sections

### 1. Header and Overview

```markdown
# {worker-name}

{One-sentence description of what the Worker does}

## Overview

`{worker-name}` is a **{worker-type}** that {main-functionality}.

{Additional overview details}
```

### 2. Business Logic

Use the [business-logic-template](../templates/business-logic-template.md):

```markdown
## Business Logic

### Message Flow

1. **Queue Trigger**: Consumes messages from `{queue-name}` queue
2. **Env Validation**: Resolves secrets ({secret-names})
3. **Message Validation**: Validates message shape
4. {Additional steps...}

### {Layer Name}

{Detailed description}
```

### 3. Queue Message Contracts

````markdown
## Queue Message Contracts

### Input Message

```typescript
interface {MessageName} {
    {field}: {type};
    {field}: {type};
}
```
````

### Output Actions

- **ack**: Message processed successfully
- **retry**: Transient failure, will be retried

````

### 4. Service Bindings

Use the [service-bindings template](../templates/service-bindings.md):

```markdown
## Service Bindings

### Cloudflare Infrastructure

| Binding Type | Name | Purpose |
|-------------|------|---------|
| Queue Consumer | `{queue-name}` | {purpose} |

### External Service Dependencies

| Service | Endpoint | Purpose |
|---------|----------|---------|
| {Service} | `{HTTP_METHOD} {endpoint}` | {purpose} |
````

### 5. Configuration

````markdown
## Configuration

### wrangler.toml

```toml
{wrangler configuration}
```
````

### Environment Variables

| Variable | Default     | Description   | Required   |
| -------- | ----------- | ------------- | ---------- |
| `{VAR}`  | `{default}` | {description} | {required} |

````

### 6. Mermaid Diagram

Use the [mermaid-flowchart template](../templates/mermaid-flowchart.md):

```markdown
## Data Flow Summary

```mermaid
flowchart TD
    START[Start] --> STEP1[Step 1]
    STEP1 --> STEP2[Step 2]
    STEP2 --> END[End]
````

````

### 7. Additional Sections

Add sections as needed:
- **Event Types** - if Worker classifies data
- **AI Model & Prompts** - for AI Workers
- **Error Handling** - retryable vs non-retryable errors
- **Performance Considerations** - cost and processing optimizations
- **Security Considerations** - secrets, authentication
- **Project Structure** - file organization
- **Dependencies** - npm packages and shared utilities
- **Testing** - test commands and coverage
- **Deployment** - deployment commands
- **Monitoring** - observability configuration
- **Integration** - upstream/downstream relationships
- **Version History** - changes over time
- **Related Workers** - links to related Workers
- **Related Backend Code** - links to backend code

## Step 5: Add Mermaid Diagrams

For complex Workers, add Mermaid diagrams for:

1. **Data Flow** - main processing pipeline
2. **Service Integration** - relationships with external services
3. **Decision Trees** - gating logic and conditions
4. **Error Handling** - error paths and retry logic

Example:

```mermaid
flowchart TD
    Q[Queue Message] --> VALIDATE
    VALIDATE -->|Valid| PROCESS
    VALIDATE -->|Invalid| REJECT
    PROCESS --> SAVE
    SAVE -->|Success| ACK
    SAVE -->|Failure| RETRY
````

## Step 6: Validate README

Check your README against this checklist:

- [ ] Worker name and description are clear
- [ ] Overview explains the purpose
- [ ] Business logic is documented in detail
- [ ] All processing steps are described
- [ ] Message contracts include TypeScript interfaces
- [ ] Service bindings are complete (Cloudflare + External)
- [ ] Configuration includes wrangler.toml and env vars
- [ ] Mermaid diagram shows data flow
- [ ] Project structure is documented
- [ ] Dependencies are listed
- [ ] Testing instructions are included
- [ ] Deployment commands are included
- [ ] Related Workers and backend code are linked

## Step 7: Test README Rendering

View your README in a Markdown viewer to ensure:

- All tables render correctly
- Mermaid diagrams display properly
- Code blocks are syntax-highlighted
- Links work correctly

## Common Patterns

### For Queue Workers

```markdown
## Overview

`{worker-name}` is a **queue-driven worker** that processes {data-type} from the `{queue-name}` queue.

## Business Logic

### Message Flow

1. **Queue Trigger**: Consumes messages from `{queue-name}` queue
2. **Message Validation**: Validates message shape and version
3. **Data Processing**: {processing description}
4. **Result Persistence**: Saves results to backend
```

### For AI Workers

```markdown
## Overview

`{worker-name}` is a **queue-driven AI analysis worker** that processes {data-type} using {AI-provider} models.

## Business Logic

Implements a multi-layer processing pipeline:
```

Layer 0: Cleaner (Text Normalization)
↓
Layer 0.5: Prefilter (Rule-based)
↓
Layer 1: Screening (AI, Relevance Assessment)
↓
Layer 2: Deep Analysis (AI, Final Extraction)
↓
Backend Persistence

```

### Layer 0: Cleaner

Fast, deterministic text normalization...
```

### For Scheduled Workers

```markdown
## Overview

`{worker-name}` is a **scheduled worker** that runs every {interval} to {function}.

## Business Logic

### Schedule

Runs every {interval} via Cloudflare Cron Trigger (`{cron-expression}`)

### Processing Flow

1. **Data Fetch**: Retrieves {data-type} from backend
2. **Aggregation**: Aggregates data by {grouping}
3. **Analysis**: Calculates {metrics}
4. **Persistence**: Saves aggregated results
```

## Tips for Good README Files

### 1. Be Specific

- Use actual variable names, queue names, endpoint URLs
- Include real examples when helpful

### 2. Be Complete

- Document all environment variables
- List all service bindings
- Describe all processing steps

### 3. Be Consistent

- Follow the same structure as other TokenBel Workers
- Use the same formatting and style
- Use consistent terminology

### 4. Be Visual

- Use Mermaid diagrams for complex workflows
- Use tables for structured data
- Use code blocks for interfaces and configuration

### 5. Be Maintainable

- Update README when code changes
- Keep diagrams in sync with code
- Review README during code reviews

## Example: Creating a README for a New Worker

Let's say you're creating `tb-data-sync` Worker:

```bash
# 1. Navigate to worker directory
cd /workspace/Red-Panda-Dev__tbel/cf_workers/tb-data-sync

# 2. Copy template
cp /workspace/Red-Panda-Dev__tbel/.agents/skills/cloudflare-worker-readme/templates/README-template.md README.md

# 3. Edit README.md with your Worker's information
vim README.md

# 4. Fill in all sections based on your Worker's code
# 5. Add Mermaid diagrams
# 6. Validate and test
```

## References

- [TokenBel Worker Patterns](./tokenbel-patterns.md) - Established patterns in TokenBel Workers
- [Business Logic Template](../templates/business-logic-template.md) - Template for business logic section
- [Mermaid Flowchart Template](../templates/mermaid-flowchart.md) - Mermaid diagram examples
- [Service Bindings Template](../templates/service-bindings.md) - Service bindings examples
- [Example README](https://github.com/RedPandaDev/tbel/blob/main/cf_workers/tb-news-ai-analyzer/README.md) - Well-documented Worker example

## Need Help?

If you're unsure about any section, refer to:

1. The [SKILL.md](../SKILL.md) for detailed guidance
2. Existing Worker README files for examples
3. The TokenBel patterns document for conventions
