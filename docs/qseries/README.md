# Q-Series Live-Mirroring Integration Documentation

This directory contains complete specifications for integrating Q-Series sensor data recording into Cockpit with live continuous mirroring to the topside computer.

## Document Index

| File | Description | Target Audience |
|------|-------------|-----------------|
| [01-architecture.md](01-architecture.md) | System architecture, data flow, component responsibilities | All developers |
| [02-api-contract.md](02-api-contract.md) | Complete REST API specification with examples | API consumers, testers |
| [03-pi-chunking.md](03-pi-chunking.md) | Pi-side WAL implementation and chunk writer | Backend developers |
| [04-topside-storage.md](04-topside-storage.md) | Electron service implementation for chunk pulling | Frontend/Electron developers |
| [05-cockpit-changes.md](05-cockpit-changes.md) | File-level Cockpit modifications with line citations | Cockpit contributors |
| [06-qsensor-api-changes.md](06-qsensor-api-changes.md) | Q_Sensor_API modifications with line citations | Q-Sensor maintainers |
| [07-testing-plan.md](07-testing-plan.md) | Unit, integration, and hardware-in-the-loop tests | QA engineers, testers |
| [08-security.md](08-security.md) | Security requirements and validation rules | Security reviewers |
| [09-performance.md](09-performance.md) | Performance budgets and optimization strategies | Performance engineers |
| [10-migration-plan.md](10-migration-plan.md) | PR sequence, timeline, and risks | Project managers |
| [11-patch-samples.md](11-patch-samples.md) | Minimal code diffs for critical files | All developers |

## Quick Start

**For Understanding the System**:
1. Read [01-architecture.md](01-architecture.md) for overall design
2. Review [02-api-contract.md](02-api-contract.md) for API details
3. Check [10-migration-plan.md](10-migration-plan.md) for implementation timeline

**For Implementation**:
1. Start with [06-qsensor-api-changes.md](06-qsensor-api-changes.md) (PR1)
2. Follow [05-cockpit-changes.md](05-cockpit-changes.md) (PR2-3)
3. Use [11-patch-samples.md](11-patch-samples.md) as reference

**For Testing**:
1. Review [07-testing-plan.md](07-testing-plan.md) for test cases
2. Run unit tests first
3. Proceed to hardware-in-the-loop tests

## Key Design Decisions

1. **Live Mirroring**: Chunks pulled every 15s (default), configurable 15-300s interval
2. **Chunk Size**: 60-second chunks by default (~6-630 KB depending on sample rate)
3. **Format**: CSV (not Parquet) for simplicity and readability
4. **Integrity**: SHA256 on every chunk
5. **Storage**: `~/Library/Application Support/Cockpit/qsensor/`
6. **Recovery**: Idempotent resume on reconnect
7. **Bandwidth**: Configurable cap (default 500 KB/s)

## Architecture at a Glance

```
[Cockpit Widget] ─── HTTP/SSE ──→ [Q_Sensor_API (Pi)]
       ↓                                   ↓
[qsensorStore]                    [RecordingManager]
       ↓                                   ↓
[Electron Service] ←─ Poll 15s ── [ChunkWriter + Manifest]
       ↓                                   ↓
[Local Storage]                    [/usr/blueos/userdata/qsensor/]
```

## Development Workflow

### Phase 1: Q_Sensor_API (Pi-Side)
- Implement RecordingManager FSM
- Add ChunkWriter with atomic writes
- Create manifest management
- Add SSE broadcaster
- **Duration**: 5 days

### Phase 2: Cockpit Widget (UI)
- Create MiniQSensorRecorder.vue
- Implement qsensorStore
- Add qsensor-client.ts
- Wire to video recording callbacks
- **Duration**: 4 days

### Phase 3: Electron Service (Topside)
- Implement QSensorStorageService
- Add chunk downloader with verification
- Create atomic writer
- Add IPC bridge
- **Duration**: 4 days

### Phase 4: Settings & Recovery
- Add settings UI
- Implement recovery logic
- Test failure scenarios
- **Duration**: 2 days

### Phase 5: Documentation & Testing
- Write user documentation
- Complete E2E tests
- Hardware validation
- **Duration**: 3 days

**Total Timeline**: 18 days (~3.5 weeks)

## Testing Strategy

1. **Unit Tests**: API contracts, chunk logic, integrity checks
2. **Integration Tests**: Full workflow with fake sensor
3. **Hardware Tests**: Real Q-Series sensor on Pi
4. **Failure Tests**: Tether disconnect, disk full, crashes
5. **Performance Tests**: 500 Hz sustained recording, bandwidth

## Security Considerations

- Localhost binding (BlueOS network only)
- Input validation on all endpoints
- Rate limiting (4-60 req/min depending on endpoint)
- SHA256 integrity verification
- No authentication (trusted network)

## Performance Targets

| Metric | Target |
|--------|--------|
| Chunk write latency (Pi) | < 100 ms |
| Chunk download time | < 5 s |
| Sync lag (normal) | 15-75 s |
| Sync lag (extreme) | < 5 s |
| CPU overhead (Pi) | < 2% |
| CPU overhead (topside) | < 1% |
| Memory (Pi) | < 50 MB |
| Memory (topside) | < 20 MB |

## Support & Contact

- **Issues**: File in Bio_cockpit repository
- **Q-Sensor API**: See Q_Sensor_API/README.md
- **BlueOS Extensions**: https://blueos.cloud/docs/

## Version

**Current**: 1.0 (Initial design)
**Last Updated**: 2025-11-11
