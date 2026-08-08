# Mermaid Flowchart Templates

Use these templates for creating Mermaid diagrams in Cloudflare Worker README files.

## Basic Flowchart Structure

```mermaid
flowchart TD
    START[Start] --> STEP1[Step 1: Description]
    STEP1 --> STEP2[Step 2: Description]
    STEP2 --> END[End]
```

## Queue Worker Flowchart

```mermaid
flowchart TD
    QI[Queue Message In\nfield1, field2, field3] --> VALIDATE
    
    VALIDATE[Validate Message] -->|Valid| FETCH
    VALIDATE -->|Invalid| REJECT1[Record Error\nstage: validation]
    
    FETCH[Fetch Data from Backend] --> PROCESS
    FETCH -->|Not Found| REJECT2[Record Error\nstage: fetch]
    
    PROCESS[Process Data] --> TRANSFORM
    TRANSFORM[Transform Data] --> SAVE
    
    SAVE[Save to Backend] -->|Success| ACK[Message Acked]
    SAVE -->|Failure| RETRY[Retry Message]
```

## Multi-Layer Processing Flowchart (AI Worker)

```mermaid
flowchart TD
    QI[Queue Message In\nraw_article_id, source_slug,\ncontent_hash, article_url_hash] --> FETCH

    FETCH[Backend API: GET\n/api/internal/news/raw-articles/id] --> L0

    L0[Layer 0: Cleaner] --> L0D[Unicode NFKC\nInvisible char removal\nEmoji removal\nLowercase + ё → е\nDash/quote normalization\nBoilerplate line removal\nPunctuation-only line removal\nLemma replacement\nBlank-line collapse]

    L0D --> L05{Layer 0.5:\nPrefilter}
    L05 -- FAIL --> REJECT[Record processing failure\nstage: layer0_5_prefilter]
    L05 -- PASS --> TRUNC

    TRUNC[Text Truncation\nSlice cleaned text to\nARTICLE_TEXT_MAX_CHARS] --> L1

    L1[Layer 1: Screening\nMistral: Relevance check] --> L1R[is_relevant, decision,\nrelevance_score, categories]

    L1R --> GATE{Gate:\nrelevance >= 0.65 AND\nis_relevant AND\ndeep_analyze AND\ncategories.length > 0?}

    GATE -- No --> SAVE1[Map partial results\nSave with layer: 1]
    GATE -- Yes --> L21

    L21[Layer 2.1: Fact Distillation\nMistral: audit-only facts] --> L21R[distilled_facts, values,\nnamed_objects, candidates]
    L21R --> L22
    L22[Layer 2.2: Event Builder\nMistral: final event extraction] --> L2R[event_type, impact_type,\nentities, tags, summary]

    L2R --> MAP

    MAP[Mapping & Tag Normalization\nNormalize tag slugs/labels\nDeduplicate tags\nMap entity types\nConstruct audit payload] --> SAVE2

    SAVE1 --> RESULT
    SAVE2[Backend API: POST\n/api/internal/news/raw-articles/id/analysis] --> RESULT

    RESULT[Analysis saved or\nProcessing failure recorded]
```

## Decision Tree Flowchart

```mermaid
flowchart TD
    START[Start Processing] --> CHECK1{Condition 1?}
    
    CHECK1 -->|Yes| ACTION1[Action 1]
    CHECK1 -->|No| CHECK2{Condition 2?}
    
    ACTION1 --> CHECK3{Condition 3?}
    CHECK2 -->|Yes| ACTION2[Action 2]
    CHECK2 -->|No| REJECT[Reject]
    
    CHECK3 -->|Yes| SUCCESS[Success Path]
    CHECK3 -->|No| ACTION3[Action 3]
    
    ACTION2 --> SUCCESS
    ACTION3 --> CHECK4{Final Check?}
    
    CHECK4 -->|Yes| SUCCESS
    CHECK4 -->|No| FAIL[Failure]
```

## Error Handling Flowchart

```mermaid
flowchart TD
    START[Start] --> PROCESS[Process Message]
    
    PROCESS --> ERROR1{Transient Error?}
    ERROR1 -->|Yes| RETRY[Retry up to 3 times]
    ERROR1 -->|No| ERROR2{Retryable Error?}
    
    RETRY --> PROCESS
    RETRY --> MAXRETRY{Max retries exceeded?}
    MAXRETRY -->|Yes| RECORD[Record Failure]
    MAXRETRY -->|No| PROCESS
    
    ERROR2 -->|Yes| RETRY
    ERROR2 -->|No| RECORD
    
    RECORD --> ACK[Message Acked]
```

## Service Integration Flowchart

```mermaid
flowchart TD
    subgraph Cloudflare
        WORKER[Cloudflare Worker]
        QUEUE[Queue: tb-news-raw-article-saved]
        SECRETS[Secrets Store]
    end
    
    subgraph External Services
        BACKEND[TokenBel Backend\nhttps://dashboard.tokenbel.info]
        MISTRAL[Mistral AI\nhttps://api.mistral.ai]
    end
    
    QUEUE -->|Trigger| WORKER
    SECRETS -->|API_TOKEN\nMISTRAL_API_KEY| WORKER
    
    WORKER -->|GET /api/internal/news/raw-articles/{id}| BACKEND
    WORKER -->|POST https://api.mistral.ai/v1/chat/completions| MISTRAL
    WORKER -->|POST /api/internal/news/raw-articles/{id}/analysis| BACKEND
    WORKER -->|POST /api/internal/news/raw-articles/{id}/processing-failure| BACKEND
```

## Data Flow with Upstream/Downstream

```mermaid
flowchart TD
    subgraph Upstream
        EXTRACTOR[tb-news-article-extractor]
    end
    
    subgraph Current Worker
        ANALYZER[tb-news-ai-analyzer]
    end
    
    subgraph Downstream
        BACKEND[TokenBel Backend]
        DATABASE[(Database)]
    end
    
    EXTRACTOR -->|Consumes: tb-news-articles-discovered| EXTRACTOR
    EXTRACTOR -->|Fetches article HTML| EXTRACTOR
    EXTRACTOR -->|Extracts normalized Markdown| EXTRACTOR
    EXTRACTOR -->|Saves to backend| BACKEND
    EXTRACTOR -->|Produces: tb-news-raw-article-saved\n(if should_analyze=true)| ANALYZER
    
    ANALYZER -->|Consumes: tb-news-raw-article-saved| ANALYZER
    ANALYZER -->|GET /api/internal/news/raw-articles/{id}| BACKEND
    ANALYZER -->|POST analysis results| BACKEND
    ANALYZER -->|POST processing failures| BACKEND
    
    BACKEND -->|Saves to| DATABASE
```

## Scheduled Worker Flowchart

```mermaid
flowchart TD
    CRON[Cron Trigger\n0 * * * *] --> WORKER
    
    WORKER --> CHECK_TIME{Within processing window?}
    CHECK_TIME -->|No| EXIT[Exit]
    CHECK_TIME -->|Yes| FETCH_STATS
    
    FETCH_STATS[GET /api/internal/statistics\n?period=last_hour] --> AGGREGATE
    AGGREGATE[Aggregate by category\nand time period] --> ANALYZE
    ANALYZE[Calculate trends\nand anomalies] --> CHECK_ALERTS
    
    CHECK_ALERTS{Alerts needed?} -->|Yes| SEND_ALERT
    CHECK_ALERTS -->|No| SAVE
    
    SEND_ALERT[POST to webhook\nfor critical conditions] --> SAVE
    SAVE[POST /api/internal/statistics/hourly] --> EXIT
```

## Batch Processing Flowchart

```mermaid
flowchart TD
    QUEUE[Queue: max_batch_size=10] --> BATCH[Receive Batch]
    
    BATCH --> ITEM1[Item 1]
    BATCH --> ITEM2[Item 2]
    BATCH --> ITEM3[Item ...]
    BATCH --> ITEM10[Item 10]
    
    ITEM1 --> PROCESS1[Process Item 1]
    ITEM2 --> PROCESS2[Process Item 2]
    ITEM10 --> PROCESS10[Process Item 10]
    
    PROCESS1 --> COLLECT[Collect Results]
    PROCESS2 --> COLLECT
    PROCESS10 --> COLLECT
    
    COLLECT --> AGGREGATE[Aggregate Results]
    AGGREGATE --> SAVE[Batch Save]
    SAVE --> ACK[Batch Acked]
```

## State Machine Flowchart

```mermaid
flowchart TD
    START[Start] --> IDLE[Idle]
    
    IDLE -->|Message Received| PROCESSING[Processing]
    PROCESSING -->|Success| COMPLETED[Completed]
    PROCESSING -->|Error| ERROR[Error]
    
    COMPLETED -->|Ack| IDLE
    ERROR -->|Retryable| PROCESSING
    ERROR -->|Non-Retryable| FAILED[Failed]
    
    FAILED -->|Record Failure| IDLE
```

## Parallel Processing Flowchart

```mermaid
flowchart TD
    START[Start] --> SPLIT[Split into parallel tasks]
    
    SPLIT --> TASK1[Task 1]
    SPLIT --> TASK2[Task 2]
    SPLIT --> TASK3[Task 3]
    
    TASK1 --> WAIT1[Wait for Task 1]
    TASK2 --> WAIT2[Wait for Task 2]
    TASK3 --> WAIT3[Wait for Task 3]
    
    WAIT1 --> JOIN[Join Results]
    WAIT2 --> JOIN
    WAIT3 --> JOIN
    
    JOIN --> COMBINE[Combine Results]
    COMBINE --> END[End]
```

## Customizing Diagrams

### Adding Styles

```mermaid
flowchart TD
    A[Start] --> B[Process]
    B --> C{Decision}
    
    style A fill:#f9f,stroke:#333
    style C fill:#bbf,stroke:#333,stroke-width:2px
```

### Adding Classes

```mermaid
flowchart TD
    classDef success fill:#9f9,stroke:#333
    classDef error fill:#f99,stroke:#333
    classDef process fill:#f9f,stroke:#333
    
    START[Start] --> PROCESS[Process]:::process
    PROCESS --> SUCCESS[Success]:::success
    PROCESS --> ERROR[Error]:::error
```

### Adding Notes

```mermaid
flowchart TD
    A[Step 1] --> B[Step 2]
    B --> C[Step 3]
    
    note right of A
        This is a note about Step 1
        It can span multiple lines
    end note
```

### Subgraphs for Grouping

```mermaid
flowchart TD
    subgraph Input
        A[Queue]
        B[Secrets]
    end
    
    subgraph Processing
        C[Worker]
        D[Backend API]
    end
    
    subgraph Output
        E[Database]
        F[Cache]
    end
    
    A --> C
    B --> C
    C --> D
    D --> E
    D --> F
```

## Best Practices for Worker Diagrams

1. **Start with the trigger**: Queue, Cron, or HTTP request
2. **Show the main flow**: Primary processing path
3. **Include decision points**: Use diamonds (`{}`) for conditions
4. **Show error paths**: Use arrows with labels for different outcomes
5. **Group related components**: Use subgraphs for Cloudflare vs External services
6. **Keep it readable**: Limit to 10-15 nodes for complex diagrams
7. **Use consistent naming**: Match variable and function names from code
8. **Add notes for context**: Explain non-obvious decisions or optimizations
