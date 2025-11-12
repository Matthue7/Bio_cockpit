# Q-Sensor API Minimal Changes

**Generated**: 2025-11-12
**Purpose**: Define required API endpoints and minimal implementation changes

## Current State Analysis

**File**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py`

The existing Q_Sensor_API provides:
- ✅ POST `/connect` - Connect to sensor
- ✅ POST `/config` - Configure sensor
- ✅ POST `/start` - Start acquisition
- ✅ POST `/stop` - Stop acquisition
- ✅ POST `/recording/start` - Start DataRecorder (in-memory DataFrame)
- ✅ POST `/recording/stop` - Stop DataRecorder with optional flush
- ✅ GET `/status` - Get current status
- ✅ GET `/stats` - Get data statistics
- ✅ GET `/latest` - Get latest reading
- ✅ GET `/export/csv` - Export to CSV (all data at once)
- ✅ GET `/export/parquet` - Export to Parquet (all data at once)
- ✅ WebSocket `/stream` - Real-time streaming

### What's Missing

The current API uses an **in-memory DataFrame** approach with end-of-run export. For live mirroring, we need:

❌ **POST `/record/start`** - Start chunked recording session with configurable interval
❌ **POST `/record/stop`** - Stop chunked recording
❌ **GET `/record/status`** - Get recording session status (chunk count, elapsed time)
❌ **GET `/record/snapshots`** - Get list of available chunks with SHA256 hashes
❌ **GET `/files/{session_id}/{filename}`** - Download individual chunk files
❌ **GET `/instrument/health`** - Simplified health check for connection monitoring

## Required Endpoints

### 1. POST `/record/start`

**Purpose**: Start a new chunked recording session

**Request Body**:
```json
{
  "chunk_interval_s": 60,
  "metadata": {
    "mission": "DeepDive_2025-11-12",
    "linked_recording": "2025-11-12T14-30-45_video"
  }
}
```

**Response**:
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "start_time": "2025-11-12T14:30:45.123456Z",
  "chunk_interval_s": 60,
  "storage_path": "/data/qsensor_recordings/550e8400-e29b-41d4-a716-446655440000"
}
```

**Behavior**:
- Auto-connects if not connected (using env vars for serial port/baud)
- Starts acquisition in freerun mode
- Starts DataRecorder with background chunk flushing
- Chunks written to `/data/qsensor_recordings/{session_id}/chunk_XXXXX.jsonl`
- Returns 400 if already recording

---

### 2. POST `/record/stop`

**Purpose**: Stop the current chunked recording session

**Request Body**:
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response**:
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "final_chunk_count": 5,
  "total_rows": 4523,
  "duration_s": 302.5
}
```

**Behavior**:
- Stops DataRecorder (flushes final chunk)
- Stops acquisition
- Does NOT disconnect (allows immediate restart)
- Returns 400 if not recording or session_id mismatch

---

### 3. GET `/record/status`

**Purpose**: Get current recording session status

**Query Parameters**: `session_id` (optional, validates if provided)

**Response**:
```json
{
  "is_recording": true,
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "chunk_count": 3,
  "elapsed_time_s": 185.2,
  "current_chunk_rows": 1247,
  "total_rows": 2856
}
```

**Behavior**:
- Returns current state of active recording session
- If session_id provided, validates it matches active session
- Returns `is_recording: false` if no active session

---

### 4. GET `/record/snapshots`

**Purpose**: Get manifest of available chunks with integrity hashes

**Query Parameters**: `session_id` (required)

**Response**:
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "chunks": [
    {
      "index": 0,
      "filename": "chunk_00000.jsonl",
      "size_bytes": 124800,
      "row_count": 1200,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "created_at": "2025-11-12T14:31:45.000Z"
    },
    {
      "index": 1,
      "filename": "chunk_00001.jsonl",
      "size_bytes": 125100,
      "row_count": 1203,
      "sha256": "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da",
      "created_at": "2025-11-12T14:32:45.000Z"
    }
  ],
  "total_chunks": 2,
  "total_size_bytes": 249900
}
```

**Behavior**:
- Scans recording directory for chunk files
- Computes SHA256 for each chunk
- Returns sorted list by chunk index
- Used by topside for reconciliation

---

### 5. GET `/files/{session_id}/{filename}`

**Purpose**: Download a specific chunk file

**Path Parameters**:
- `session_id`: Recording session UUID
- `filename`: Chunk filename (e.g., `chunk_00000.jsonl`)

**Response**: FileResponse with `application/x-ndjson` media type

**Behavior**:
- Validates session_id exists
- Returns 404 if file not found
- Returns 403 if path traversal attempt detected
- Sets appropriate Content-Length header

---

### 6. GET `/instrument/health`

**Purpose**: Simplified health check for Q-Sensor connection

**Response**:
```json
{
  "connected": true,
  "sensor_id": "QSR-2000-0123",
  "sample_rate_hz": 15.2,
  "last_reading_age_s": 0.3,
  "state": "ACQ_FREERUN"
}
```

**Behavior**:
- Returns connection state and sensor vitals
- `last_reading_age_s` indicates data freshness
- Used by topside to verify Q-Sensor availability before recording

---

## Implementation Diff

**File**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py`

### Add Chunk Recording State

```diff
--- a/api/main.py
+++ b/api/main.py
@@ -18,6 +18,7 @@ import logging
 import os
 import threading
+import uuid
 from pathlib import Path
 from threading import RLock
 from typing import Literal, Optional
@@ -25,6 +26,7 @@ from typing import Literal, Optional
 from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
 from fastapi.middleware.cors import CORSMiddleware
 from fastapi.responses import FileResponse
+from fastapi.responses import JSONResponse
 from fastapi.staticfiles import StaticFiles
 from pydantic import BaseModel

@@ -60,6 +62,13 @@ LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
 _controller: Optional[SensorController] = None
 _store: Optional[DataStore] = None
 _recorder: Optional[DataRecorder] = None
+_chunk_session: Optional[dict] = None  # Active chunk recording session
 _lock = RLock()  # Protects state-changing operations

+# Chunk recording configuration
+CHUNK_RECORDING_BASE_PATH = Path(os.getenv("CHUNK_RECORDING_PATH", "/data/qsensor_recordings"))
+CHUNK_RECORDING_BASE_PATH.mkdir(parents=True, exist_ok=True)
+
 # =============================================================================
 # FastAPI App
 # =============================================================================
```

### Add Request/Response Models

```diff
@@ -130,6 +139,31 @@ class StatsResponse(BaseModel):
     est_sample_rate_hz: Optional[float]


+class ChunkRecordingStartRequest(BaseModel):
+    """Request body for POST /record/start."""
+    chunk_interval_s: int = 60
+    metadata: Optional[dict] = None
+
+
+class ChunkRecordingStartResponse(BaseModel):
+    """Response for POST /record/start."""
+    session_id: str
+    start_time: str
+    chunk_interval_s: int
+    storage_path: str
+
+
+class ChunkRecordingStatusResponse(BaseModel):
+    """Response for GET /record/status."""
+    is_recording: bool
+    session_id: Optional[str]
+    chunk_count: int
+    elapsed_time_s: float
+
+
+class InstrumentHealthResponse(BaseModel):
+    """Response for GET /instrument/health."""
+    connected: bool
+    sample_rate_hz: float
+    last_reading_age_s: float
+
+
 # =============================================================================
```

### Add Chunk Recording Endpoints

```diff
@@ -719,6 +753,228 @@ async def export_parquet():
     )


+# =============================================================================
+# Chunk-Based Recording Endpoints (for Live Mirroring)
+# =============================================================================
+
+@app.post("/record/start", response_model=ChunkRecordingStartResponse)
+async def start_chunk_recording(request: ChunkRecordingStartRequest):
+    """Start a new chunked recording session.
+
+    Auto-connects to sensor if not already connected, starts acquisition in freerun mode,
+    and begins recording data to chunked JSONL files.
+
+    Args:
+        request: Configuration with chunk_interval_s and optional metadata
+
+    Returns:
+        Session ID, start time, and storage path
+
+    Raises:
+        400: If already recording
+    """
+    global _controller, _store, _recorder, _chunk_session, _lock
+
+    with _lock:
+        if _chunk_session is not None:
+            raise HTTPException(status_code=400, detail="Recording already in progress")
+
+        # Auto-connect if needed
+        if _controller is None:
+            logger.info(f"Auto-connecting to {DEFAULT_SERIAL_PORT}...")
+            _controller = SensorController()
+            _controller.connect(port=DEFAULT_SERIAL_PORT, baud=DEFAULT_SERIAL_BAUD)
+
+        # Generate session ID and create storage directory
+        session_id = str(uuid.uuid4())
+        session_path = CHUNK_RECORDING_BASE_PATH / session_id
+        session_path.mkdir(parents=True, exist_ok=True)
+
+        # Create metadata file
+        metadata_file = session_path / "metadata.json"
+        import json
+        from datetime import datetime, timezone
+        start_time = datetime.now(timezone.utc)
+        metadata = {
+            "session_id": session_id,
+            "start_time": start_time.isoformat(),
+            "chunk_interval_s": request.chunk_interval_s,
+            "sensor_id": _controller.sensor_id,
+            **(request.metadata or {})
+        }
+        metadata_file.write_text(json.dumps(metadata, indent=2))
+
+        # Create DataStore with chunked flushing
+        chunk_rows = request.chunk_interval_s * 20  # ~20 Hz max sample rate estimate
+        _store = ChunkedDataStore(
+            session_path=session_path,
+            chunk_interval_s=request.chunk_interval_s,
+            max_rows=chunk_rows * 2  # Buffer 2 chunks
+        )
+
+        # Start acquisition
+        if _controller.state == ConnectionState.CONFIG_MENU:
+            _controller.start_acquisition(poll_hz=1.0)
+
+        # Start recorder
+        _recorder = DataRecorder(_controller, _store, poll_interval_s=0.2)
+        _recorder.start()
+
+        # Track session state
+        _chunk_session = {
+            "session_id": session_id,
+            "start_time": start_time,
+            "chunk_interval_s": request.chunk_interval_s,
+            "storage_path": str(session_path),
+            "chunk_count": 0
+        }
+
+        logger.info(f"Chunk recording started: {session_id}")
+        return ChunkRecordingStartResponse(
+            session_id=session_id,
+            start_time=start_time.isoformat(),
+            chunk_interval_s=request.chunk_interval_s,
+            storage_path=str(session_path)
+        )
+
+
+@app.post("/record/stop")
+async def stop_chunk_recording(session_id: str):
+    """Stop the current chunked recording session.
+
+    Args:
+        session_id: Session UUID to validate
+
+    Returns:
+        Final statistics (chunk count, row count, duration)
+
+    Raises:
+        400: If not recording or session_id mismatch
+    """
+    global _controller, _recorder, _chunk_session, _lock
+
+    with _lock:
+        if _chunk_session is None:
+            raise HTTPException(status_code=400, detail="No recording in progress")
+
+        if _chunk_session["session_id"] != session_id:
+            raise HTTPException(status_code=400, detail="Session ID mismatch")
+
+        # Stop recorder (flushes final chunk)
+        if _recorder and _recorder.is_running():
+            _recorder.stop()
+
+        # Stop acquisition
+        if _controller and _controller.state in (ConnectionState.ACQ_FREERUN, ConnectionState.ACQ_POLLED):
+            _controller.stop()
+
+        # Get final stats
+        session_path = Path(_chunk_session["storage_path"])
+        chunk_files = sorted(session_path.glob("chunk_*.jsonl"))
+        final_chunk_count = len(chunk_files)
+
+        stats = _store.get_stats() if _store else {}
+        from datetime import datetime, timezone
+        duration_s = (datetime.now(timezone.utc) - _chunk_session["start_time"]).total_seconds()
+
+        result = {
+            "session_id": session_id,
+            "final_chunk_count": final_chunk_count,
+            "total_rows": stats.get("row_count", 0),
+            "duration_s": duration_s
+        }
+
+        _chunk_session = None
+        logger.info(f"Chunk recording stopped: {session_id}")
+        return result
+
+
+@app.get("/record/status", response_model=ChunkRecordingStatusResponse)
+async def get_chunk_recording_status(session_id: Optional[str] = None):
+    """Get current chunk recording status.
+
+    Args:
+        session_id: Optional session UUID to validate
+
+    Returns:
+        Current recording state (is_recording, chunk_count, elapsed_time_s)
+    """
+    global _chunk_session
+
+    if _chunk_session is None:
+        return ChunkRecordingStatusResponse(
+            is_recording=False,
+            session_id=None,
+            chunk_count=0,
+            elapsed_time_s=0.0
+        )
+
+    if session_id and _chunk_session["session_id"] != session_id:
+        raise HTTPException(status_code=400, detail="Session ID mismatch")
+
+    # Count chunks
+    session_path = Path(_chunk_session["storage_path"])
+    chunk_files = sorted(session_path.glob("chunk_*.jsonl"))
+    chunk_count = len(chunk_files)
+
+    # Calculate elapsed time
+    from datetime import datetime, timezone
+    elapsed_time_s = (datetime.now(timezone.utc) - _chunk_session["start_time"]).total_seconds()
+
+    return ChunkRecordingStatusResponse(
+        is_recording=True,
+        session_id=_chunk_session["session_id"],
+        chunk_count=chunk_count,
+        elapsed_time_s=elapsed_time_s
+    )
+
+
+@app.get("/record/snapshots")
+async def get_chunk_snapshots(session_id: str):
+    """Get manifest of available chunks with SHA256 hashes.
+
+    Args:
+        session_id: Session UUID
+
+    Returns:
+        List of chunks with metadata (index, filename, size, sha256, created_at)
+    """
+    session_path = CHUNK_RECORDING_BASE_PATH / session_id
+    if not session_path.exists():
+        raise HTTPException(status_code=404, detail="Session not found")
+
+    chunk_files = sorted(session_path.glob("chunk_*.jsonl"))
+    chunks = []
+
+    import hashlib
+    for chunk_file in chunk_files:
+        # Extract chunk index from filename
+        index = int(chunk_file.stem.split('_')[1])
+
+        # Compute SHA256
+        sha256 = hashlib.sha256(chunk_file.read_bytes()).hexdigest()
+
+        chunks.append({
+            "index": index,
+            "filename": chunk_file.name,
+            "size_bytes": chunk_file.stat().st_size,
+            "sha256": sha256,
+            "created_at": chunk_file.stat().st_mtime
+        })
+
+    return {
+        "session_id": session_id,
+        "chunks": chunks,
+        "total_chunks": len(chunks),
+        "total_size_bytes": sum(c["size_bytes"] for c in chunks)
+    }
+
+
+@app.get("/files/{session_id}/{filename}")
+async def download_chunk_file(session_id: str, filename: str):
+    """Download a specific chunk file.
+
+    Args:
+        session_id: Session UUID
+        filename: Chunk filename (e.g., chunk_00000.jsonl)
+
+    Returns:
+        FileResponse with JSONL content
+    """
+    # Validate filename to prevent path traversal
+    if ".." in filename or "/" in filename:
+        raise HTTPException(status_code=403, detail="Invalid filename")
+
+    session_path = CHUNK_RECORDING_BASE_PATH / session_id
+    chunk_file = session_path / filename
+
+    if not chunk_file.exists() or not chunk_file.is_file():
+        raise HTTPException(status_code=404, detail="File not found")
+
+    return FileResponse(
+        path=chunk_file,
+        media_type="application/x-ndjson",
+        filename=filename
+    )
+
+
+@app.get("/instrument/health", response_model=InstrumentHealthResponse)
+async def get_instrument_health():
+    """Get Q-Sensor connection health status.
+
+    Returns:
+        Connection state, sample rate, and data freshness
+    """
+    global _controller, _store
+
+    if not _controller or not _controller.is_connected():
+        return InstrumentHealthResponse(
+            connected=False,
+            sample_rate_hz=0.0,
+            last_reading_age_s=999.0
+        )
+
+    # Get latest reading age
+    last_reading_age_s = 999.0
+    if _store:
+        latest = _store.get_latest()
+        if latest:
+            from datetime import datetime, timezone
+            import dateutil.parser
+            latest_ts = dateutil.parser.isoparse(latest["timestamp"])
+            last_reading_age_s = (datetime.now(timezone.utc) - latest_ts).total_seconds()
+
+    # Get sample rate
+    sample_rate_hz = 0.0
+    if _store:
+        stats = _store.get_stats()
+        sample_rate_hz = stats.get("est_sample_rate_hz", 0.0)
+
+    return InstrumentHealthResponse(
+        connected=True,
+        sample_rate_hz=sample_rate_hz,
+        last_reading_age_s=last_reading_age_s
+    )
+
+
 # =============================================================================
```

### Add ChunkedDataStore Class

**File**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/store.py`

```diff
@@ -300,3 +300,58 @@ class DataRecorder:
         logger.info(f"DataRecorder stopped. {total_reads} total reads, {total_rows} total rows appended.")

         return flush_path
+
+
+class ChunkedDataStore(DataStore):
+    """DataStore subclass that auto-flushes to chunked JSONL files.
+
+    Extends DataStore with automatic chunk flushing at fixed time intervals.
+    Each chunk is written to session_path/chunk_XXXXX.jsonl.
+    """
+
+    def __init__(
+        self,
+        session_path: Path,
+        chunk_interval_s: int = 60,
+        max_rows: int = 2000
+    ) -> None:
+        """Initialize chunked data store.
+
+        Args:
+            session_path: Directory for chunk files
+            chunk_interval_s: Flush interval in seconds
+            max_rows: Max rows in memory before trimming
+        """
+        super().__init__(max_rows=max_rows, auto_flush_interval_s=None)
+        self._session_path = Path(session_path)
+        self._chunk_interval_s = chunk_interval_s
+        self._chunk_index = 0
+        self._last_flush_time = time.time()
+
+    def append_readings(self, readings: Iterable[Reading]) -> None:
+        """Append readings and auto-flush if chunk interval elapsed."""
+        super().append_readings(readings)
+
+        # Check if chunk interval elapsed
+        now = time.time()
+        if now - self._last_flush_time >= self._chunk_interval_s:
+            self._flush_chunk()
+
+    def _flush_chunk(self) -> None:
+        """Flush current DataFrame to chunk file and reset."""
+        with self._lock:
+            if self._df.empty:
+                return
+
+            chunk_filename = f"chunk_{self._chunk_index:05d}.jsonl"
+            chunk_path = self._session_path / chunk_filename
+
+            # Write JSONL (atomic: temp + rename)
+            temp_path = chunk_path.with_suffix('.tmp')
+            self._df.to_json(temp_path, orient='records', lines=True)
+            temp_path.rename(chunk_path)
+
+            logger.info(f"Flushed chunk {self._chunk_index} ({len(self._df)} rows) to {chunk_filename}")
+
+            self._chunk_index += 1
+            self._last_flush_time = time.time()
+            self._df = pd.DataFrame(columns=list(SCHEMA.keys()))  # Reset
```

---

## Environment Variables

Add to `Dockerfile` or `.env`:

```bash
# Chunk recording storage path (default: /data/qsensor_recordings)
CHUNK_RECORDING_PATH=/data/qsensor_recordings

# Default serial port and baud for auto-connect
SERIAL_PORT=/dev/ttyUSB0
SERIAL_BAUD=9600
```

---

## API Port Configuration

The integration plan assumes Q_Sensor_API runs on **port 9150** (not 8000). Update deployment:

**Dockerfile**:
```diff
-ENV API_PORT=8000
+ENV API_PORT=9150
-EXPOSE 8000
+EXPOSE 9150
```

**docker-compose.yml**:
```yaml
services:
  qsensor-api:
    ports:
      - "9150:9150"
    environment:
      - API_PORT=9150
      - CHUNK_RECORDING_PATH=/data/qsensor_recordings
    volumes:
      - qsensor_data:/data/qsensor_recordings
```

---

## Testing Checklist

- [ ] POST `/record/start` creates session directory and metadata.json
- [ ] Chunks flush at configured interval (verify with 15s interval)
- [ ] POST `/record/stop` flushes final chunk
- [ ] GET `/record/status` returns accurate chunk count
- [ ] GET `/record/snapshots` computes correct SHA256 hashes
- [ ] GET `/files/{session_id}/{filename}` serves chunk files
- [ ] GET `/instrument/health` reports correct connection state
- [ ] Path traversal blocked in `/files/` endpoint
- [ ] Concurrent recording prevented (400 error)
- [ ] Auto-connect works when sensor not connected

---

## Summary

**Required Changes**:
1. Add 6 new endpoints to `api/main.py` (~250 lines)
2. Add `ChunkedDataStore` class to `data_store/store.py` (~60 lines)
3. Update environment variables and deployment config
4. Total: ~310 lines of new code + configuration updates

**Key Features**:
- Chunked JSONL recording with configurable intervals
- SHA256 integrity verification via manifest
- Idempotent chunk download (topside can reconcile)
- Atomic writes (temp + rename)
- Auto-connect on recording start
- Session isolation (UUID-based directories)

**Deployment Note**: This requires Q_Sensor_API to be deployed on the ROV at **http://blueos.local:9150** as a BlueOS extension.
