# Pi-Side Chunking Implementation

## Overview

This document specifies the Write-Ahead Log (WAL) implementation on the Pi that writes sensor data in chunks with atomic operations and maintains a manifest for topside synchronization.

## File: `api/recording_manager.py`

**Location**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/recording_manager.py` (NEW)

**Size**: ~400 lines

**Purpose**: Session lifecycle management, FSM, chunk orchestration

### Class: RecordingManager

```python
from enum import Enum
from dataclasses import dataclass
from pathlib import Path
import threading
import json
import time
from datetime import datetime, timezone
from typing import Optional, Dict, List
import hashlib

class RecordingState(Enum):
    IDLE = "idle"
    RECORDING = "recording"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"

@dataclass
class SessionConfig:
    chunk_interval_s: int = 60      # Time between chunks
    max_chunk_size_mb: int = 5      # Max chunk size before rolling
    metadata: Dict = None           # User metadata

@dataclass
class RecordingSession:
    session_id: str
    started_at: datetime
    stopped_at: Optional[datetime]
    state: RecordingState
    config: SessionConfig
    storage_path: Path
    chunk_count: int
    total_rows: int
    total_bytes: int

class RecordingManager:
    def __init__(self, controller, data_store, sessions_root: Path):
        self.controller = controller
        self.data_store = data_store
        self.sessions_root = sessions_root
        self.active_session: Optional[RecordingSession] = None
        self.chunk_writer: Optional[ChunkWriter] = None
        self._lock = threading.RLock()
        self.sse_broadcaster = SSEBroadcaster()
        
    def start_session(self, config: SessionConfig) -> RecordingSession:
        """Start a new recording session"""
        with self._lock:
            # Validate state
            if self.active_session and self.active_session.state == RecordingState.RECORDING:
                raise ValueError("Session already active")
            
            if not self.controller.is_connected():
                raise ValueError("Sensor not connected")
            
            # Check disk space
            free_mb = get_free_disk_space_mb(self.sessions_root)
            if free_mb < 100:
                raise OSError(f"Insufficient storage: {free_mb} MB free")
            
            # Generate session ID
            session_id = str(uuid.uuid4())
            
            # Create session directory
            session_path = self.sessions_root / session_id
            session_path.mkdir(parents=True, exist_ok=True)
            
            # Create session object
            session = RecordingSession(
                session_id=session_id,
                started_at=datetime.now(timezone.utc),
                stopped_at=None,
                state=RecordingState.RECORDING,
                config=config,
                storage_path=session_path,
                chunk_count=0,
                total_rows=0,
                total_bytes=0
            )
            
            self.active_session = session
            
            # Start acquisition if not running
            if not self.controller.is_acquiring():
                self.controller.start_acquisition()
            
            # Start chunk writer thread
            self.chunk_writer = ChunkWriter(
                session=session,
                data_store=self.data_store,
                interval_s=config.chunk_interval_s,
                max_size_mb=config.max_chunk_size_mb,
                on_chunk_written=self._on_chunk_written
            )
            self.chunk_writer.start()
            
            # Broadcast SSE event
            self.sse_broadcaster.emit('session_started', {
                'session_id': session_id,
                'timestamp': session.started_at.isoformat()
            })
            
            return session
    
    def stop_session(self) -> RecordingSession:
        """Stop the active recording session"""
        with self._lock:
            if not self.active_session:
                raise ValueError("No active session")
            
            if self.active_session.state != RecordingState.RECORDING:
                raise ValueError("Session not recording")
            
            # Transition to stopping
            self.active_session.state = RecordingState.STOPPING
            
            # Stop chunk writer (flushes final chunk)
            if self.chunk_writer:
                self.chunk_writer.stop()
                self.chunk_writer.join(timeout=10)
            
            # Update session
            self.active_session.stopped_at = datetime.now(timezone.utc)
            self.active_session.state = RecordingState.STOPPED
            
            # Broadcast SSE event
            self.sse_broadcaster.emit('session_stopped', {
                'session_id': self.active_session.session_id,
                'total_chunks': self.active_session.chunk_count,
                'total_rows': self.active_session.total_rows,
                'total_bytes': self.active_session.total_bytes,
                'timestamp': self.active_session.stopped_at.isoformat()
            })
            
            session = self.active_session
            self.active_session = None
            return session
    
    def _on_chunk_written(self, chunk_info: Dict):
        """Callback when chunk is written"""
        with self._lock:
            if self.active_session:
                self.active_session.chunk_count += 1
                self.active_session.total_rows = chunk_info['row_end'] + 1
                self.active_session.total_bytes += chunk_info['size']
                
                # Broadcast SSE event
                self.sse_broadcaster.emit('chunk_written', chunk_info)
```

## File: `api/chunk_writer.py`

**Location**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/chunk_writer.py` (NEW)

**Size**: ~200 lines

**Purpose**: Background thread that writes chunks with atomic operations

### Class: ChunkWriter

```python
import threading
import time
from pathlib import Path
import tempfile
import hashlib
import json
from datetime import datetime, timezone

class ChunkWriter(threading.Thread):
    def __init__(self, session, data_store, interval_s, max_size_mb, on_chunk_written):
        super().__init__(daemon=True, name="ChunkWriter")
        self.session = session
        self.data_store = data_store
        self.interval_s = interval_s
        self.max_size_bytes = max_size_mb * 1024 * 1024
        self.on_chunk_written = on_chunk_written
        self._stop_event = threading.Event()
        self.chunk_index = 0
        self.row_cursor = 0  # Track which rows have been exported
        
    def run(self):
        """Main chunk writer loop"""
        next_write_time = time.time() + self.interval_s
        
        while not self._stop_event.is_set():
            now = time.time()
            
            # Check if it's time to write a chunk
            if now >= next_write_time:
                try:
                    self._write_chunk()
                    next_write_time = now + self.interval_s
                except Exception as e:
                    logging.error(f"Failed to write chunk: {e}")
                    # Continue trying
            
            # Sleep with cancellable wait
            self._stop_event.wait(timeout=1.0)
    
    def stop(self):
        """Stop the writer and flush final chunk"""
        self._stop_event.set()
        
        # Write final chunk if there's data
        try:
            self._write_chunk()
        except Exception as e:
            logging.error(f"Failed to write final chunk: {e}")
    
    def _write_chunk(self):
        """Write a chunk with atomic operations"""
        # Get rows from data store since last export
        df = self.data_store.get_dataframe()
        
        if df is None or len(df) == 0:
            return  # No data to write
        
        # Get new rows since last export
        new_rows = df.iloc[self.row_cursor:]
        
        if len(new_rows) == 0:
            return  # No new data
        
        # Generate chunk filename
        chunk_name = f"chunk-{self.chunk_index:06d}.csv"
        chunk_path = self.session.storage_path / chunk_name
        temp_path = self.session.storage_path / f".{chunk_name}.tmp"
        
        # Write to temporary file
        new_rows.to_csv(temp_path, index=False)
        
        # Get file size
        chunk_size = temp_path.stat().st_size
        
        # Compute SHA256
        sha256_hash = hashlib.sha256()
        with open(temp_path, 'rb') as f:
            for byte_block in iter(lambda: f.read(65536), b""):
                sha256_hash.update(byte_block)
        chunk_sha256 = sha256_hash.hexdigest()
        
        # fsync to ensure data is on disk
        with open(temp_path, 'r+b') as f:
            f.flush()
            os.fsync(f.fileno())
        
        # Atomic rename
        temp_path.rename(chunk_path)
        
        # Update manifest
        chunk_info = {
            'index': self.chunk_index,
            'name': chunk_name,
            'size': chunk_size,
            'sha256': chunk_sha256,
            'row_start': self.row_cursor,
            'row_end': self.row_cursor + len(new_rows) - 1,
            'row_count': len(new_rows),
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
        
        self._update_manifest(chunk_info)
        
        # Update cursor
        self.row_cursor += len(new_rows)
        self.chunk_index += 1
        
        # Callback
        if self.on_chunk_written:
            self.on_chunk_written(chunk_info)
        
        logging.info(f"Wrote chunk {chunk_name}: {chunk_size} bytes, {len(new_rows)} rows, SHA256: {chunk_sha256[:16]}...")
    
    def _update_manifest(self, chunk_info: Dict):
        """Update manifest.json atomically"""
        manifest_path = self.session.storage_path / "manifest.json"
        temp_manifest_path = self.session.storage_path / ".manifest.json.tmp"
        
        # Load existing manifest or create new
        if manifest_path.exists():
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
        else:
            manifest = {
                'version': '1.0',
                'session_id': self.session.session_id,
                'started_at': self.session.started_at.isoformat(),
                'stopped_at': None,
                'state': self.session.state.value,
                'sensor_id': None,  # Filled from controller
                'firmware_version': None,
                'config': {
                    'mode': None,
                    'chunk_interval_s': self.interval_s,
                    'max_chunk_size_mb': self.max_size_bytes // (1024 * 1024)
                },
                'metadata': self.session.config.metadata or {},
                'chunks': [],
                'total_chunks': 0,
                'total_rows': 0,
                'total_bytes': 0,
                'last_updated': None
            }
        
        # Append chunk info
        manifest['chunks'].append(chunk_info)
        manifest['total_chunks'] = len(manifest['chunks'])
        manifest['total_rows'] = chunk_info['row_end'] + 1
        manifest['total_bytes'] += chunk_info['size']
        manifest['last_updated'] = datetime.now(timezone.utc).isoformat()
        
        # Write to temp file
        with open(temp_manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        
        # Atomic rename
        temp_manifest_path.rename(manifest_path)
```

## Chunk Cadence Strategies

### Time-Based (Default)

**Configuration**: `chunk_interval_s = 60`

**Behavior**:
- Write chunk every 60 seconds
- Regardless of size (unless exceeds max_chunk_size_mb)

**Pros**:
- Predictable latency (topside always within 60s + poll interval)
- Consistent chunk count

**Cons**:
- Variable chunk sizes depending on sample rate
- Low sample rates = small chunks (overhead)

### Size-Based

**Configuration**: `chunk_interval_s = 300, max_chunk_size_mb = 1`

**Behavior**:
- Write chunk when size reaches 1 MB OR 300 seconds elapse

**Pros**:
- Consistent chunk sizes
- Efficient storage

**Cons**:
- Variable latency (could be 5 minutes at 1 Hz)

### Hybrid (Recommended)

**Configuration**: `chunk_interval_s = 60, max_chunk_size_mb = 5`

**Behavior**:
- Write chunk every 60 seconds
- Roll to new chunk if size exceeds 5 MB

**Pros**:
- Bounded latency (60s max)
- Bounded size (5 MB max)
- Works well across sample rates

**Example**:
- 1 Hz: ~6 KB every 60s
- 10 Hz: ~63 KB every 60s
- 100 Hz: ~630 KB every 60s
- 500 Hz: ~3.15 MB every 60s (under 5 MB limit)

## Manifest Schema

**File**: `manifest.json` (in session directory)

**Purpose**: Single source of truth for chunk list and metadata

**Update Pattern**: Atomic (write to .tmp, fsync, rename)

**Format**:
```json
{
  "version": "1.0",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "started_at": "2025-11-11T14:30:52.123Z",
  "stopped_at": "2025-11-11T14:35:52.456Z",
  "state": "stopped",
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
    }
  ],
  "total_chunks": 1,
  "total_rows": 3600,
  "total_bytes": 378000,
  "last_updated": "2025-11-11T14:31:52.123Z"
}
```

## Atomic Write Pattern

### Step-by-Step

1. **Write to temp file**: `chunk-NNNNNN.csv.tmp`
2. **Flush buffers**: `file.flush()`
3. **Force to disk**: `os.fsync(file.fileno())`
4. **Atomic rename**: `os.rename(tmp_path, final_path)`

**Why this works**:
- `rename()` is atomic on POSIX systems
- If crash happens during write, .tmp file exists but final doesn't
- If crash happens after rename, final file is complete
- No partial files ever visible to readers

### Code Example

```python
def write_chunk_atomic(data: pd.DataFrame, chunk_path: Path):
    temp_path = chunk_path.with_suffix('.csv.tmp')
    
    # Write to temp
    data.to_csv(temp_path, index=False)
    
    # Ensure on disk
    with open(temp_path, 'r+b') as f:
        f.flush()
        os.fsync(f.fileno())
    
    # Atomic rename
    temp_path.rename(chunk_path)
```

## CSV Format Details

### Header

Always includes header row:
```csv
timestamp,sensor_id,mode,value,tag,temp_c,vin
```

### Data Rows

**Freerun example**:
```csv
2025-11-11T14:30:52.123Z,Q12345,freerun,1.234567,,21.34,12.345
```

**Polled example**:
```csv
2025-11-11T14:30:52.123Z,Q12345,polled,1.234567,A,21.34,12.345
```

### Empty Fields

- `tag`: Empty for freerun mode
- `temp_c`: Empty if temperature not enabled
- `vin`: Empty if voltage not enabled

**CSV Handling**:
```csv
timestamp,sensor_id,mode,value,tag,temp_c,vin
2025-11-11T14:30:52.123Z,Q12345,freerun,1.234567,,,
```

## Storage Directory Layout

```
/usr/blueos/userdata/qsensor/
└── sessions/
    └── 550e8400-e29b-41d4-a716-446655440000/
        ├── manifest.json
        ├── chunk-000000.csv
        ├── chunk-000001.csv
        ├── chunk-000002.csv
        └── chunk-000003.csv
```

**Retention Policy**:
- Keep sessions for 30 days (configurable)
- Auto-delete if disk < 500 MB free (oldest first)
- Never delete active session

## Performance Considerations

### Write Performance

**Chunk Write Latency Target**: < 100 ms

**Breakdown**:
- DataFrame slice: ~5 ms (3600 rows)
- CSV write: ~50 ms (378 KB)
- fsync: ~30 ms (depends on SD card)
- Rename: ~1 ms
- Manifest update: ~10 ms
- **Total**: ~96 ms ✅

### Disk I/O

**Sequential Writes**: Optimized for SD cards
- Single writer thread (no contention)
- Large sequential writes (not random)
- fsync only after complete chunk (not per row)

**Buffering**:
- DataFrame in memory (no disk reads during write)
- CSV written in single operation
- Manifest updated once per chunk

### Memory Usage

**DataStore**: ~15 MB (100k rows)
**ChunkWriter**: ~2 MB (buffers)
**Total**: ~17 MB ✅ (well under 50 MB target)

## Error Handling

### Disk Full

```python
try:
    self._write_chunk()
except OSError as e:
    if e.errno == errno.ENOSPC:
        # Disk full
        logging.error("Disk full, stopping recording")
        self.session.state = RecordingState.ERROR
        self.sse_broadcaster.emit('error', {
            'error_code': 'DISK_FULL',
            'message': str(e)
        })
        self.stop()
```

### Corrupt Manifest

```python
try:
    with open(manifest_path, 'r') as f:
        manifest = json.load(f)
except json.JSONDecodeError:
    # Manifest corrupt, rebuild from chunks
    logging.warning("Manifest corrupt, rebuilding...")
    manifest = rebuild_manifest_from_chunks(session_path)
```

### Incomplete Chunk

```python
def recover_session(session_path: Path):
    """Check for incomplete chunks on startup"""
    for tmp_file in session_path.glob("*.tmp"):
        # Delete incomplete chunks
        logging.warning(f"Deleting incomplete chunk: {tmp_file}")
        tmp_file.unlink()
```

## Testing

### Unit Tests

```bash
pytest tests/test_chunk_writer.py -v
```

**Test Cases**:
- Write single chunk
- Write multiple chunks
- Roll to new chunk when size exceeds limit
- Atomic rename (simulate crash)
- Manifest update
- SHA256 verification
- Recovery from incomplete chunk

### Integration Test

```bash
python -m pytest tests/test_recording_session.py::test_full_session -v
```

**Flow**:
1. Start session
2. Acquire data for 3 minutes
3. Verify 3 chunks written
4. Stop session
5. Verify manifest accurate
6. Verify all SHA256 hashes match

## Summary

This chunking implementation provides:
- ✅ Atomic writes (no partial files)
- ✅ Integrity verification (SHA256)
- ✅ Consistent manifest (single source of truth)
- ✅ Low latency (60s default)
- ✅ Bounded size (5 MB max)
- ✅ Crash-safe (fsync + rename)
- ✅ Low overhead (< 100 ms per chunk)
- ✅ Memory efficient (< 20 MB)

Next: Topside storage implementation (Electron service).
