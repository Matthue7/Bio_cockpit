# Q-Series Integration: Executive Summary

## Status: Ready for Implementation

**Generated**: 2025-11-11  
**Total Documentation**: 12 files, ~80 pages  
**Review Time**: ~2 hours to read all docs

## What We're Building

A **live-mirroring system** that continuously backs up Q-Series sensor data to the topside computer while recording is in progress. If power or tether fails mid-mission, the topside already has almost all data (lag = 15-75 seconds).

## Key Features

✅ **Single-button UX**: User clicks Record in Cockpit, Q-Sensor starts automatically  
✅ **Continuous mirroring**: Chunks pulled every 15s (configurable)  
✅ **Whale-proof**: Topside has data even if Pi dies  
✅ **Idempotent recovery**: Auto-resume on reconnect  
✅ **Atomic writes**: Both sides use temp + rename  
✅ **Bandwidth control**: Configurable cap (500 KB/s default)  
✅ **Integrity verified**: SHA256 on every chunk  

## Architecture Choice

**Extension Boundary with Live Chunk Pull**

- Q_Sensor_API: BlueOS extension (REST + SSE on port 9150)
- Cockpit: Electron background service polls for chunks
- Storage: Pi writes chunks, topside pulls and verifies
- No end-of-run export dependency

**Justification**: Cockpit already has background service pattern (video-recording.ts, network.ts). Adding Q-Sensor puller follows established conventions.

## Data Flow

```
User clicks Record
    ↓
POST http://blueos.local:9150/record/start
    ↓
Pi: Start acquisition → Write chunk every 60s → Update manifest.json
    ↓
Topside (parallel): Poll every 15s → Download new chunks → Verify SHA256 → Atomic write
    ↓
User clicks Stop
    ↓
POST /record/stop
    ↓
Topside: Pull final chunks (within 30s) → Done
```

## Implementation Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| PR1: Q_Sensor_API chunking | 5 days | REST API + chunk writer + SSE |
| PR2: Cockpit widget UI | 4 days | MiniQSensorRecorder.vue + store |
| PR3: Electron puller service | 4 days | Background chunk downloader |
| PR4: Settings & recovery | 2 days | Config UI + idempotent resume |
| PR5: Testing & docs | 3 days | E2E tests + user guide |
| **Total** | **18 days** | **(~3.5 weeks)** |

## File Map

| File | Purpose | Read When |
|------|---------|-----------|
| 01-architecture.md | System design, data flow | First - understand big picture |
| 02-api-contract.md | REST API spec | Implementing API or client |
| 03-pi-chunking.md | WAL implementation | Working on Q_Sensor_API backend |
| 04-topside-storage.md | Electron service | Working on Cockpit Electron code |
| 05-cockpit-changes.md | File-level Cockpit mods | Making Cockpit changes |
| 06-qsensor-api-changes.md | File-level Q_Sensor mods | Making Q_Sensor changes |
| 07-testing-plan.md | Test cases + commands | Writing tests |
| 08-security.md | Security requirements | Security review |
| 09-performance.md | Performance budgets | Optimization work |
| 10-migration-plan.md | PR sequence + risks | Project planning |
| 11-patch-samples.md | Code diffs | Quick reference while coding |

## Quick Decisions

### Why CSV not Parquet?
- Simpler append operation
- Human-readable for debugging
- Smaller files at typical rates (1-10 Hz)
- Parquet overhead not justified

### Why 60s chunks?
- Balance between latency and overhead
- 1 Hz → 6 KB/chunk (tiny)
- 100 Hz → 630 KB/chunk (reasonable)
- Configurable 15-300s for tuning

### Why polling not push?
- Simpler Pi-side (no reverse connection)
- Cockpit controls bandwidth (pull rate)
- Easier recovery (compare manifest vs local dir)
- SSE for real-time events (optional)

### Why Electron service?
- Follows existing Cockpit pattern
- Native filesystem access
- Background operation (survives tab refresh)
- IPC to renderer for UI updates

## Next Steps

1. **Review**: Read 01-architecture.md + 02-api-contract.md (~45 min)
2. **Approve**: Sign off on approach
3. **Branch**: Create feature branches in both repos
4. **Implement**: Start PR1 (Q_Sensor_API chunking)
5. **Test**: Unit tests first, then HIL
6. **Iterate**: PR2, PR3, PR4, PR5

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Network congestion during download | Medium | Low | Bandwidth cap + backlog monitoring |
| Pi reboot loses active session | Low | Medium | Resume logic + manifest persistence |
| Topside disk full | Low | High | Pre-check + alert UI |
| Chunk integrity fail | Low | Medium | Retry download + log error |
| SSE connection drops | Medium | Low | Polling fallback |

## Success Criteria

- [ ] User can start recording with one button click
- [ ] Chunks appear on topside within 75s
- [ ] Tether disconnect → auto-resume on reconnect
- [ ] Cockpit restart → resume pulling missing chunks
- [ ] All data verified with SHA256
- [ ] Bandwidth stays under 500 KB/s cap
- [ ] UI shows sync status (timer, bytes, backlog)
- [ ] Tests pass (unit + HIL + failure drills)

## Questions?

See full documentation in this directory:
- `/Users/matthuewalsh/Bio_cockpit/docs/qseries/`

Or review README.md for document index.

---

**Ready to proceed?** Start with PR1: Q_Sensor_API chunking system (see 06-qsensor-api-changes.md).
