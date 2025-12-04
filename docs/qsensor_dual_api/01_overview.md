# Q-Sensor Dual-API Integration Overview

## Problem Statement

Cockpit currently supports a single Q_Sensor_API instance running on ROV's BlueOS Pi. The architecture assumes that in-water sensor uses HTTP backend while surface sensor uses direct serial connection to topside computer. This limitation prevents using a surface reference sensor that also runs Q_Sensor_API on a separate Raspberry Pi, which would provide consistent data collection and time synchronization across both sensors.

The goal is to enable dual Q_Sensor_API support: one instance on ROV (in-water sensor) and another on a separate surface reference Pi. Both sensors would use the same HTTP API protocol but connect to different hosts, allowing unified data collection, mirroring, and time synchronization across both measurement points.

## Current Architecture Summary

### Sensor Modeling
- **In-water sensor**: Pre-configured with `backendType: 'http'` and `apiBaseUrl: 'http://blueos.local:9150'`
- **Surface sensor**: Initialized with `backendType: null`, requiring user to select API or Serial mode
- Both sensors have `apiBaseUrl` fields in type definitions, but only the in-water sensor is initialized with a value

### Backend Type and API URL Handling
- **Backend types**: 'http' for Q_Sensor_API communication, 'serial' for direct topside connection
- **API URL management**: Global computed property only references in-water sensor
- **Persistence**: Config store lacks separate storage for surface sensor API URL
- **UI limitation**: Both sensors would use the same API URL input field

### Hard-coded Assumptions
- **Port 9150**: Hard-coded in `qsensor-mirror.ts` for sync marker injection, chunk downloads, and snapshots
- **BlueOS hostname**: Default `http://blueos.local:9150` in multiple locations
- **No discovery service**: Referenced `qsensor-host-discovery.ts` file doesn't exist

## Design Goals and Constraints

### Primary Goals
- Enable surface sensor to use HTTP backend with separate API URL
- Maintain full backward compatibility with existing in-water sensor workflows
- Support simultaneous dual-sensor recording with independent API hosts
- Preserve existing mirroring and time synchronization functionality

### Technical Constraints
- No relay/proxy architecture - use direct HTTP to both API instances
- Port 9150 remains default but should be configurable per sensor
- Surface sensor API URL must be manually configured (Phase 1)
- No changes to core data collection or fusion logic

## Networking Assumptions

- **Direct connectivity**: Topside computer can reach both `blueos.local` and `surfaceref.local` via mDNS/Bonjour
- **Same network**: Both Pis and topside computer on same network segment
- **No tunneling**: Direct HTTP communication without VPN or relay infrastructure
- **Host resolution**: Both `.local` hostnames resolve via multicast DNS