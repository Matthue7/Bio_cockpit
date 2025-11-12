# Q-Series API Contract

## Base URL

```
http://blueos.local:9150
```

Or with direct IP:
```
http://192.168.2.2:9150
```

**Note**: Q_Sensor_API binds to `0.0.0.0` inside container but BlueOS network isolation means it's only accessible within the BlueOS network.

## Authentication

**None** - Service is on trusted vehicle network. Security enforced via:
- Network isolation (BlueOS internal network)
- Input validation on all endpoints
- Rate limiting on expensive operations

## Error Response Format

All errors return JSON with this structure:

```json
{
  "detail": "Human-readable error message",
  "error_code": "SNAKE_CASE_ERROR_CODE",
  "timestamp": "2025-11-11T14:30:52.123Z",
  "session_id": "550e8400-e29b-41d4-a716-446655440000"  // if applicable
}
```

## HTTP Status Codes

| Code | Meaning | Use Case |
|------|---------|----------|
| 200 | OK | Request succeeded |
| 201 | Created | New session started |
| 204 | No Content | Delete succeeded |
| 400 | Bad Request | Invalid input (validation error) |
| 404 | Not Found | Session/chunk doesn't exist |
| 409 | Conflict | Already recording, can't start new session |
| 424 | Failed Dependency | Sensor not connected |
| 429 | Too Many Requests | Rate limit exceeded |
| 503 | Service Unavailable | Service not ready (starting up) |
| 507 | Insufficient Storage | Disk full |

## Endpoints

### 1. Start Recording

Start a new recording session.

**Request**:
```http
POST /record/start
Content-Type: application/json

{
  "chunk_interval_s": 60,        // Optional, default 60, range 15-300
  "max_chunk_size_mb": 5,        // Optional, default 5
  "metadata": {                  // Optional user metadata
    "mission": "Monterey Bay Survey",
    "operator": "Alice",
    "notes": "Testing new sensor"
  }
}
```

**Response** (201 Created):
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "started_at": "2025-11-11T14:30:52.123Z",
  "sensor_id": "Q12345",
  "firmware_version": "4.003",
  "config": {
    "mode": "freerun",
    "averaging": 125,
    "adc_rate_hz": 125,
    "sample_period_s": 1.0,
    "chunk_interval_s": 60,
    "max_chunk_size_mb": 5
  },
  "storage_path": "/usr/blueos/userdata/qsensor/sessions/550e8400-e29b-41d4-a716-446655440000"
}
```

**Error Responses**:

```json
// 409 Conflict - Already recording
{
  "detail": "Recording already in progress (session abc12345). Stop it first.",
  "error_code": "ALREADY_RECORDING",
  "session_id": "abc12345..."
}

// 424 Failed Dependency - Sensor not connected
{
  "detail": "Sensor not connected. Connect to /dev/ttyUSB0 first.",
  "error_code": "SENSOR_NOT_CONNECTED"
}

// 507 Insufficient Storage - Disk full
{
  "detail": "Disk space too low (45 MB free, need 100 MB minimum).",
  "error_code": "INSUFFICIENT_STORAGE",
  "available_mb": 45,
  "required_mb": 100
}

// 400 Bad Request - Invalid chunk interval
{
  "detail": "chunk_interval_s must be between 15 and 300 seconds.",
  "error_code": "INVALID_CHUNK_INTERVAL",
  "value": 5,
  "min": 15,
  "max": 300
}
```

---

### 2. Stop Recording

Stop the active recording session and finalize the last chunk.

**Request**:
```http
POST /record/stop
Content-Type: application/json

{
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response** (200 OK):
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "stopped_at": "2025-11-11T14:35:52.456Z",
  "duration_s": 300.333,
  "total_chunks": 5,
  "total_rows": 18000,
  "total_bytes": 1890000,
  "final_chunk": {
    "index": 4,
    "name": "chunk-000004.csv",
    "size": 378000,
    "sha256": "d4e5f6...",
    "row_count": 3600
  }
}
```

**Error Responses**:

```json
// 404 Not Found - Session doesn't exist
{
  "detail": "Session 550e8400... not found or not recording.",
  "error_code": "SESSION_NOT_FOUND",
  "session_id": "550e8400..."
}

// 409 Conflict - Already stopped
{
  "detail": "Session already stopped at 2025-11-11T14:35:52Z.",
  "error_code": "ALREADY_STOPPED",
  "stopped_at": "2025-11-11T14:35:52.456Z"
}
```

---

### 3. Get Recording Status

Get the current status of a recording session.

**Request**:
```http
GET /record/status?session_id=550e8400-e29b-41d4-a716-446655440000
```

**Response** (200 OK - recording):
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "recording",
  "started_at": "2025-11-11T14:30:52.123Z",
  "elapsed_s": 123.5,
  "rows_captured": 7410,
  "bytes_written": 777450,
  "chunks_written": 2,
  "last_chunk": {
    "index": 1,
    "name": "chunk-000001.csv",
    "size": 378000,
    "timestamp": "2025-11-11T14:32:52.123Z"
  },
  "current_chunk_rows": 30,
  "sensor_health": {
    "connected": true,
    "last_reading_age_s": 1.02
  }
}
```

**Response** (200 OK - stopped):
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "stopped",
  "started_at": "2025-11-11T14:30:52.123Z",
  "stopped_at": "2025-11-11T14:35:52.456Z",
  "duration_s": 300.333,
  "rows_captured": 18000,
  "bytes_written": 1890000,
  "chunks_written": 5
}
```

**Error Responses**:

```json
// 404 Not Found
{
  "detail": "Session 550e8400... not found.",
  "error_code": "SESSION_NOT_FOUND"
}
```

---

### 4. List Available Chunks (Snapshots)

Get the list of all chunks for a session with integrity hashes.

**Request**:
```http
GET /record/snapshots?session_id=550e8400-e29b-41d4-a716-446655440000
```

**Response** (200 OK):
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "recording",
  "chunk_interval_s": 60,
  "chunks": [
    {
      "index": 0,
      "name": "chunk-000000.csv",
      "size": 378000,
      "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
      "row_start": 0,
      "row_end": 3599,
      "timestamp": "2025-11-11T14:31:52.123Z",
      "download_url": "/files/550e8400-e29b-41d4-a716-446655440000/chunk-000000.csv"
    },
    {
      "index": 1,
      "name": "chunk-000001.csv",
      "size": 378000,
      "sha256": "b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567",
      "row_start": 3600,
      "row_end": 7199,
      "timestamp": "2025-11-11T14:32:52.456Z",
      "download_url": "/files/550e8400-e29b-41d4-a716-446655440000/chunk-000001.csv"
    },
    {
      "index": 2,
      "name": "chunk-000002.csv",
      "size": 126000,
      "sha256": "c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567890",
      "row_start": 7200,
      "row_end": 8399,
      "timestamp": "2025-11-11T14:33:52.789Z",
      "download_url": "/files/550e8400-e29b-41d4-a716-446655440000/chunk-000002.csv"
    }
  ],
  "total_chunks": 3,
  "total_bytes": 882000,
  "total_rows": 8400
}
```

**Query Parameters**:
- `session_id` (required) - Session UUID
- `since_index` (optional) - Only return chunks with index > this value (for incremental fetches)

**Example with since_index**:
```http
GET /record/snapshots?session_id=550e8400...&since_index=1
```

Returns only chunks with index >= 2.

**Error Responses**:

```json
// 404 Not Found
{
  "detail": "Session 550e8400... not found.",
  "error_code": "SESSION_NOT_FOUND"
}

// 429 Too Many Requests
{
  "detail": "Rate limit exceeded. Max 4 requests per minute.",
  "error_code": "RATE_LIMIT_EXCEEDED",
  "retry_after_s": 15
}
```

---

### 5. Download Chunk File

Download a specific chunk file.

**Request**:
```http
GET /files/{session_id}/{chunk_name}
```

**Example**:
```http
GET /files/550e8400-e29b-41d4-a716-446655440000/chunk-000002.csv
```

**Response** (200 OK):
```
Content-Type: text/csv
Content-Length: 126000
Content-Disposition: attachment; filename="chunk-000002.csv"
ETag: "c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567890"

timestamp,sensor_id,mode,value,tag,temp_c,vin
2025-11-11T14:33:52.123Z,Q12345,freerun,1.234567,,21.34,12.345
2025-11-11T14:33:53.125Z,Q12345,freerun,1.234568,,21.35,12.346
...
```

**Range Requests Supported**:
```http
GET /files/550e8400.../chunk-000002.csv
Range: bytes=0-1023
```

**Response** (206 Partial Content):
```
Content-Type: text/csv
Content-Length: 1024
Content-Range: bytes 0-1023/126000

(first 1024 bytes)
```

**Error Responses**:

```json
// 404 Not Found - Session doesn't exist
{
  "detail": "Session 550e8400... not found.",
  "error_code": "SESSION_NOT_FOUND"
}

// 404 Not Found - Chunk doesn't exist
{
  "detail": "Chunk 'chunk-000999.csv' not found in session 550e8400...",
  "error_code": "CHUNK_NOT_FOUND",
  "available_chunks": ["chunk-000000.csv", "chunk-000001.csv", "chunk-000002.csv"]
}

// 429 Too Many Requests
{
  "detail": "Rate limit exceeded. Max 10 chunk downloads per minute.",
  "error_code": "RATE_LIMIT_EXCEEDED",
  "retry_after_s": 6
}
```

---

### 6. Server-Sent Events (SSE)

Subscribe to real-time updates for a recording session.

**Request**:
```http
GET /events?session_id=550e8400-e29b-41d4-a716-446655440000
Accept: text/event-stream
```

**Response** (200 OK):
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: session_started
data: {"session_id":"550e8400...","timestamp":"2025-11-11T14:30:52.123Z"}

event: chunk_written
data: {"session_id":"550e8400...","chunk_index":0,"chunk_name":"chunk-000000.csv","size":378000,"sha256":"a1b2c3...","timestamp":"2025-11-11T14:31:52.123Z"}

event: status_update
data: {"session_id":"550e8400...","rows":3650,"bytes":382650,"chunks":1,"elapsed_s":65.0}

event: chunk_written
data: {"session_id":"550e8400...","chunk_index":1,"chunk_name":"chunk-000001.csv","size":378000,"sha256":"b2c3d4...","timestamp":"2025-11-11T14:32:52.456Z"}

event: status_update
data: {"session_id":"550e8400...","rows":7250,"bytes":760650,"chunks":2,"elapsed_s":125.0}

event: session_stopped
data: {"session_id":"550e8400...","total_chunks":5,"total_rows":18000,"total_bytes":1890000,"timestamp":"2025-11-11T14:35:52.456Z"}
```

**Event Types**:

| Event | Data Fields | Frequency |
|-------|-------------|-----------|
| `session_started` | session_id, timestamp | Once at start |
| `chunk_written` | session_id, chunk_index, chunk_name, size, sha256, timestamp | Every chunk (default 60s) |
| `status_update` | session_id, rows, bytes, chunks, elapsed_s | Every 5s |
| `session_stopped` | session_id, total_chunks, total_rows, total_bytes, timestamp | Once at stop |
| `error` | session_id, error_code, message, timestamp | On error |

**Error Event Example**:
```
event: error
data: {"session_id":"550e8400...","error_code":"DISK_FULL","message":"Failed to write chunk-000005.csv: No space left on device","timestamp":"2025-11-11T14:36:00.000Z"}
```

**Connection Management**:
- Client should reconnect on disconnect (exponential backoff)
- Server sends `ping` event every 30s to keep connection alive
- Client should close connection when session ends

---

### 7. Get Instrument Health

Get the current health status of the Q-Series sensor.

**Request**:
```http
GET /instrument/health
```

**Response** (200 OK - healthy):
```json
{
  "connected": true,
  "sensor_id": "Q12345",
  "firmware_version": "4.003",
  "port": "/dev/ttyUSB0",
  "baud": 9600,
  "state": "acq_freerun",
  "uptime_s": 3600.5,
  "last_reading": {
    "timestamp": "2025-11-11T14:35:52.123Z",
    "age_s": 1.02,
    "value": 1.234567
  },
  "error_count_24h": 0,
  "errors": []
}
```

**Response** (200 OK - degraded):
```json
{
  "connected": true,
  "sensor_id": "Q12345",
  "firmware_version": "4.003",
  "port": "/dev/ttyUSB0",
  "state": "acq_freerun",
  "uptime_s": 3600.5,
  "last_reading": {
    "timestamp": "2025-11-11T14:35:37.000Z",
    "age_s": 16.5,
    "value": 1.234567
  },
  "error_count_24h": 3,
  "errors": [
    {
      "timestamp": "2025-11-11T14:25:30.123Z",
      "type": "SerialTimeout",
      "message": "No data received for 10s",
      "recovered": true
    },
    {
      "timestamp": "2025-11-11T14:30:15.456Z",
      "type": "MalformedResponse",
      "message": "Invalid CSV format: expected 7 columns, got 5",
      "recovered": true
    }
  ],
  "warnings": [
    "Stale data: last reading 16.5s ago (expected < 2s)"
  ]
}
```

**Response** (503 Service Unavailable - disconnected):
```json
{
  "connected": false,
  "state": "disconnected",
  "last_error": {
    "timestamp": "2025-11-11T14:20:00.000Z",
    "type": "ConnectionLost",
    "message": "USB device /dev/ttyUSB0 not found"
  },
  "reconnect_attempts": 5,
  "reconnect_next_attempt_s": 8.0
}
```

---

### 8. Delete Recording Session (Admin)

Delete a recording session and all its chunks. **Use with caution.**

**Request**:
```http
DELETE /record/{session_id}
```

**Response** (204 No Content):
```
(empty body)
```

**Error Responses**:

```json
// 404 Not Found
{
  "detail": "Session 550e8400... not found.",
  "error_code": "SESSION_NOT_FOUND"
}

// 409 Conflict - Cannot delete active session
{
  "detail": "Cannot delete active recording session. Stop it first.",
  "error_code": "SESSION_ACTIVE"
}
```

---

## CSV Chunk Format

### Schema

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| timestamp | ISO 8601 string (UTC) | Sample timestamp | 2025-11-11T14:30:52.123Z |
| sensor_id | string | Sensor serial number | Q12345 |
| mode | string | Acquisition mode | freerun or polled |
| value | float | Primary sensor reading | 1.234567 |
| tag | string or empty | TAG character (polled only) | A or empty |
| temp_c | float or empty | Temperature in Celsius | 21.34 or empty |
| vin | float or empty | Line voltage | 12.345 or empty |

### Example Chunk

**chunk-000000.csv**:
```csv
timestamp,sensor_id,mode,value,tag,temp_c,vin
2025-11-11T14:30:52.123Z,Q12345,freerun,1.234567,,21.34,12.345
2025-11-11T14:30:53.125Z,Q12345,freerun,1.234568,,21.35,12.346
2025-11-11T14:30:54.127Z,Q12345,freerun,1.234569,,21.36,12.347
...
(3600 rows for 60-second chunk at 1 Hz)
```

### Chunk Naming

Format: `chunk-{index:06d}.csv`

Examples:
- `chunk-000000.csv` (first chunk)
- `chunk-000001.csv` (second chunk)
- `chunk-000123.csv` (124th chunk)

### Manifest Format

**manifest.json** (written atomically after each chunk):

```json
{
  "version": "1.0",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "started_at": "2025-11-11T14:30:52.123Z",
  "stopped_at": null,
  "state": "recording",
  "sensor_id": "Q12345",
  "firmware_version": "4.003",
  "config": {
    "mode": "freerun",
    "averaging": 125,
    "adc_rate_hz": 125,
    "sample_period_s": 1.0,
    "chunk_interval_s": 60,
    "max_chunk_size_mb": 5
  },
  "metadata": {
    "mission": "Monterey Bay Survey",
    "operator": "Alice"
  },
  "chunks": [
    {
      "index": 0,
      "name": "chunk-000000.csv",
      "size": 378000,
      "sha256": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
      "row_start": 0,
      "row_end": 3599,
      "row_count": 3600,
      "timestamp": "2025-11-11T14:31:52.123Z"
    },
    {
      "index": 1,
      "name": "chunk-000001.csv",
      "size": 378000,
      "sha256": "b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef1234567",
      "row_start": 3600,
      "row_end": 7199,
      "row_count": 3600,
      "timestamp": "2025-11-11T14:32:52.456Z"
    }
  ],
  "total_chunks": 2,
  "total_rows": 7200,
  "total_bytes": 756000,
  "last_updated": "2025-11-11T14:32:52.456Z"
}
```

---

## Rate Limits

| Endpoint | Limit | Window | Rationale |
|----------|-------|--------|-----------|
| POST /record/start | 5 requests | 1 minute | Prevent rapid start/stop cycles |
| POST /record/stop | 10 requests | 1 minute | Allow quick stops |
| GET /record/status | 60 requests | 1 minute | Support 1 Hz polling |
| GET /record/snapshots | 4 requests | 1 minute | Limit manifest fetches (default poll = 15s) |
| GET /files/{session}/{chunk} | 10 downloads | 1 minute | Prevent bulk download abuse |
| GET /events | 1 connection | per session | One SSE stream per session |
| GET /instrument/health | 60 requests | 1 minute | Support 1 Hz health checks |

**Rate Limit Headers** (included in all responses):
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1699722000
```

**429 Response** (when limit exceeded):
```json
{
  "detail": "Rate limit exceeded for GET /record/snapshots. Max 4 requests per minute.",
  "error_code": "RATE_LIMIT_EXCEEDED",
  "retry_after_s": 15,
  "limit": 4,
  "window_s": 60
}
```

---

## Error Taxonomy

| Error Code | HTTP Status | Description | Recovery |
|------------|-------------|-------------|----------|
| `ALREADY_RECORDING` | 409 | Session already active | Stop current session first |
| `SESSION_NOT_FOUND` | 404 | Session ID doesn't exist | Check session ID, list sessions |
| `ALREADY_STOPPED` | 409 | Session already stopped | No action needed |
| `SENSOR_NOT_CONNECTED` | 424 | Sensor not detected | Connect sensor, check USB |
| `INSUFFICIENT_STORAGE` | 507 | Disk space < 100 MB | Free space on Pi |
| `INVALID_CHUNK_INTERVAL` | 400 | chunk_interval_s out of range | Use 15-300 seconds |
| `INVALID_MAX_CHUNK_SIZE` | 400 | max_chunk_size_mb out of range | Use 1-100 MB |
| `CHUNK_NOT_FOUND` | 404 | Chunk file doesn't exist | Check chunk index, retry |
| `CHUNK_WRITE_FAILED` | 500 | Failed to write chunk | Check disk, permissions |
| `MANIFEST_CORRUPT` | 500 | Manifest JSON invalid | Delete .tmp files, retry |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests | Wait retry_after_s seconds |
| `SERVICE_STARTING` | 503 | Service not ready | Retry in 5 seconds |
| `INTERNAL_ERROR` | 500 | Unexpected error | Check logs, report bug |

---

## Client Implementation Guidelines

### Polling Strategy

**Recommended**:
```typescript
const POLL_INTERVAL_MS = 15000  // 15 seconds

setInterval(async () => {
  try {
    const snapshots = await fetch(
      `${BASE_URL}/record/snapshots?session_id=${sessionId}`
    ).then(r => r.json())

    // Compare with local manifest
    const missingChunks = findMissingChunks(snapshots.chunks, localManifest)

    // Download missing chunks
    for (const chunk of missingChunks) {
      await downloadAndVerifyChunk(chunk)
    }
  } catch (error) {
    console.error('Polling error:', error)
    // Continue polling on next interval
  }
}, POLL_INTERVAL_MS)
```

### Chunk Download with Verification

```typescript
async function downloadAndVerifyChunk(chunk: ChunkMetadata) {
  const url = `${BASE_URL}/files/${sessionId}/${chunk.name}`

  // Download with timeout
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)  // 30s timeout
  })

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`)
  }

  const data = await response.arrayBuffer()

  // Verify SHA256
  const hash = await crypto.subtle.digest('SHA-256', data)
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  if (hashHex !== chunk.sha256) {
    throw new Error(`Integrity check failed: expected ${chunk.sha256}, got ${hashHex}`)
  }

  // Atomic write
  const tmpPath = `${chunk.name}.tmp`
  await fs.writeFile(tmpPath, Buffer.from(data))
  await fs.fsync(tmpPath)
  await fs.rename(tmpPath, chunk.name)
}
```

### SSE Connection Management

```typescript
let eventSource: EventSource | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10

function connectSSE(sessionId: string) {
  const url = `${BASE_URL}/events?session_id=${sessionId}`

  eventSource = new EventSource(url)

  eventSource.addEventListener('chunk_written', (event) => {
    const data = JSON.parse(event.data)
    console.log('New chunk available:', data.chunk_name)
    // Trigger immediate download
    downloadChunk(data)
  })

  eventSource.addEventListener('error', () => {
    eventSource?.close()

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      console.log(`SSE error, reconnecting in ${delay}ms...`)
      setTimeout(() => connectSSE(sessionId), delay)
    }
  })

  eventSource.addEventListener('open', () => {
    console.log('SSE connected')
    reconnectAttempts = 0
  })
}
```

### Bandwidth Throttling

```typescript
class BandwidthThrottler {
  constructor(private maxBytesPerSecond: number) {}

  private bytesThisSecond = 0
  private lastReset = Date.now()

  async waitForCapacity(bytes: number) {
    const now = Date.now()

    // Reset counter every second
    if (now - this.lastReset >= 1000) {
      this.bytesThisSecond = 0
      this.lastReset = now
    }

    // Check if adding this chunk would exceed cap
    if (this.bytesThisSecond + bytes > this.maxBytesPerSecond) {
      const waitMs = 1000 - (now - this.lastReset)
      await new Promise(resolve => setTimeout(resolve, waitMs))
      this.bytesThisSecond = 0
      this.lastReset = Date.now()
    }

    this.bytesThisSecond += bytes
  }
}

// Usage
const throttler = new BandwidthThrottler(500 * 1024)  // 500 KB/s

async function downloadChunkWithThrottling(chunk: ChunkMetadata) {
  await throttler.waitForCapacity(chunk.size)
  return await downloadAndVerifyChunk(chunk)
}
```

---

## API Versioning

Current version: **v1.0**

Version is embedded in manifest format. Future versions will:
- Add version prefix to endpoints (e.g., `/v2/record/start`)
- Maintain backward compatibility for v1.0
- Provide migration guide

---

## Summary

This API provides:
- ✅ Simple REST interface for start/stop/status
- ✅ Efficient chunk listing with SHA256 integrity
- ✅ Range-request support for large chunks
- ✅ Real-time SSE updates
- ✅ Rate limiting to prevent abuse
- ✅ Clear error taxonomy with recovery guidance
- ✅ Standard CSV format with metadata
- ✅ Atomic manifest updates

Next document: Pi-side chunking implementation details.
