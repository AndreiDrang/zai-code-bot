# Business Logic Section Template

Use this template for documenting the business logic of a Cloudflare Worker.

## Basic Structure

```markdown
## Business Logic

### Message Flow

1. **Queue Trigger**: Consumes messages from `{queue-name}` queue (`max_batch_size = {size}`)
2. **Env Validation**: Resolves secrets ({secret-names}), validates required env vars
3. **Message Validation**: Validates message shape and `message_version === {version}`
4. **Data Fetch**: `{HTTP_METHOD} {endpoint}` — retrieves {data-description}
5. **Processing Step 1**: {description}
6. **Processing Step 2**: {description}
7. **Result Persistence**: `{HTTP_METHOD} {endpoint}` — saves {result-description}

### {Processing Layer Name}

{Detailed description of this processing layer}:

- **Purpose**: {what it does}
- **Input**: {what it receives}
- **Output**: {what it produces}
- **Key Operations**:
  - Operation 1: {description}
  - Operation 2: {description}
  - Operation 3: {description}
- **Performance**: {time complexity, cost, or other metrics}
```

## Example: Multi-Layer Processing (AI Worker)

```markdown
## Business Logic

### Message Flow

1. **Queue Trigger**: Consumes messages from `tb-news-raw-article-saved` queue (`max_batch_size = 1`)
2. **Env Validation**: Resolves secrets (API token, Mistral key), validates required env vars
3. **Message Validation**: Validates message shape and `message_version === 1`
4. **Raw Article Fetch**: `GET /api/internal/news/raw-articles/{id}` — retrieves title, raw_text, source, published_at, parser_metadata
5. **Layer 0 Cleaner**: Deterministic text normalization
6. **Layer 0.5 Prefilter**: Rule-based filtering on cleaned text
7. **Text Truncation**: Cleaned text truncated to `ARTICLE_TEXT_MAX_CHARS` before AI calls
8. **Layer 1 Screening**: Mistral chat completion — relevance assessment
9. **Layer 2.1 Fact Distillation**: Mistral chat completion — extracts audit-only facts
10. **Layer 2.2 Event Builder**: Mistral chat completion — builds the final event
11. **Result Mapping & Tag Normalization**: Normalizes tags, deduplicates, maps entity types
12. **Backend Save**: `POST /api/internal/news/raw-articles/{id}/analysis` — persists structured analysis

### Layer 0: Cleaner

Fast, deterministic text normalization applied to both title and raw text before any analysis:

- **Unicode Normalization**: NFKC normalization for consistent character representation
- **Invisible Character Removal**: ZWSP, BOM, soft hyphens, zero-width joiners
- **Emoji Removal**: All emoji including presentation emoji, skin-tone modifiers, flag sequences
- **NBSP → Space**: Non-breaking spaces converted to regular spaces
- **Newline Normalization**: CRLF/CR → LF; title newlines flattened to spaces
- **Lowercase + ё → е**: Case folding and Russian ё normalization
- **Dash Normalization**: em-dash, en-dash, minus → ASCII hyphen
- **Quote Normalization**: curly double/single quotes → straight quotes
- **Space Collapsing**: Runs of spaces/tabs → single space (preserves newlines)
- **Punctuation-Only Line Removal**: Lines containing no letters or digits
- **Boilerplate Removal**: 7 universal patterns (anchored, full-line only)
- **Blank-Line Collapse**: Max 2 consecutive blank lines
- **Lemma Replacement**: Whole-word lemma normalization via word-boundary regex

Cleaning is applied before truncation (clean-then-truncate) so normalization benefits the full text.

### Layer 0.5: Prefilter

Fast, deterministic filtering that rejects articles before AI calls (saving costs).

- **Minimum Text Length**: Articles with `< 50 characters` of cleaned raw text are rejected
- **Irrelevant Title Patterns**: 12 patterns checking for sports, weather, recipes, etc.
- **Financial Keyword Check**: Articles must contain at least one financial keyword

If any check fails, the article is marked as a processing failure with `stage: layer0_5_prefilter` and acked.

### Layer 1: AI Screening

Uses Mistral chat completion to determine:

- `is_relevant`: Boolean indicating if article is relevant
- `decision`: `"deep_analyze"` or `"skip"`
- `relevance_score`: 0-1 score of article relevance
- `relevance_categories`: Array of relevant categories
- `entity_type_hints`: Array of entity type hints

**Proceed to Layer 2 only if:**

- `is_relevant === true`
- `decision === "deep_analyze"`
- `relevance_score >= 0.65`
- `relevance_categories.length > 0`
```

## Example: Simple Queue Processor

```markdown
## Business Logic

### Message Flow

1. **Queue Trigger**: Consumes messages from `tb-data-sync` queue (`max_batch_size = 10`)
2. **Env Validation**: Resolves `API_TOKEN` secret, validates required env vars
3. **Message Validation**: Validates message shape and `message_version === 1`
4. **Data Fetch**: `GET /api/internal/data/{id}` — retrieves current data state
5. **Data Transformation**: Applies business rules to transform data
6. **Validation**: Validates transformed data against schema
7. **Backend Save**: `POST /api/internal/data/{id}/sync` — persists synchronized data

### Data Transformation

Applies the following business rules:

- **Rule 1**: If `status === 'pending'`, set `processed_at = now()`
- **Rule 2**: If `amount > 1000`, apply `discount_factor = 0.95`
- **Rule 3**: Normalize all string fields (trim, lowercase)
- **Rule 4**: Calculate derived fields (totals, averages)

### Validation

Validates transformed data using Zod schema:

- Required fields must be present
- Numeric fields must be within valid ranges
- String fields must match expected patterns
- Date fields must be valid ISO 8601 timestamps
```

## Example: Scheduled Worker

```markdown
## Business Logic

### Schedule

Runs every hour via Cloudflare Cron Trigger (`0 * * * *`)

### Processing Flow

1. **Time Check**: Verifies current time is within allowed processing window
2. **Data Fetch**: `GET /api/internal/statistics?period=last_hour` — retrieves recent statistics
3. **Aggregation**: Aggregates statistics by category and time period
4. **Analysis**: Calculates trends, anomalies, and insights
5. **Notification**: Sends alerts for critical conditions via webhook
6. **Persistence**: `POST /api/internal/statistics/hourly` — saves aggregated data

### Aggregation Rules

- **Group By**: category, source, time_period
- **Metrics**: count, sum, average, min, max
- **Time Windows**: 1h, 6h, 24h, 7d

### Alert Conditions

- **High Volume**: count > threshold (configurable via `ALERT_THRESHOLD`)
- **Negative Trend**: value decreased by > 10% from previous period
- **Anomaly Detection**: value outside 3 standard deviations from mean
```

## Gating Logic Template

```markdown
### Gating Logic

The worker implements a multi-stage gating system to optimize processing:
```

Stage 1: Quick Validation (Synchronous)
↓ PASS
Stage 2: Rule-Based Filtering (Synchronous)
↓ PASS
Stage 3: AI/External Service Call (Async, Costly)
↓ PASS
Stage 4: Final Validation (Synchronous)

```

**Stage 1 - Quick Validation**
- Checks: message format, required fields, content hash
- Cost: Negligible
- Rejection Rate: ~5%

**Stage 2 - Rule-Based Filtering**
- Checks: content patterns, length, keywords
- Cost: Low (CPU only)
- Rejection Rate: ~40-60%

**Stage 3 - AI Analysis**
- Checks: semantic relevance, classification
- Cost: High (API calls)
- Rejection Rate: ~20-30%

**Stage 4 - Final Validation**
- Checks: result quality, schema compliance
- Cost: Negligible
- Rejection Rate: ~1-2%

**Total Cost Savings**: By filtering in stages, we avoid ~70-80% of expensive AI calls.
```
