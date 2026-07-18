# Implementation Plan: Advanced Monitoring Suite

## Overview

This plan implements the Advanced Monitoring Suite across five subsystems: HTTP Deep Checks, Performance & Load Testing, Alerting & Incidents, Logs & Diagnostics, and Dashboard & Visualization. Each task builds incrementally, with core infrastructure first, then individual modules, followed by API integration and frontend components.

## Tasks

- [x] 1. Project setup and database schema migration
  - [x] 1.1 Install new dependencies and configure test framework
    - Add `ws`, `puppeteer-core` to dependencies
    - Add `fast-check`, `vitest` to devDependencies
    - Create `vitest.config.js` with test directory configuration
    - Create `tests/` directory structure with subdirectories for each subsystem
    - _Requirements: All (infrastructure prerequisite)_

  - [x] 1.2 Create database migration for all new tables and indexes
    - Add all new CREATE TABLE statements to `database.js` initSchema
    - Add new indexes (idx_synthetic_results_tx, idx_dns_logs_monitor, etc.)
    - Add ALTER TABLE statements for monitors (geo_enabled, diff_enabled, screenshot_enabled, diff_threshold, apdex_threshold, error_rate_threshold, timezone)
    - Add ALTER TABLE statement for logs (dns_time_ms, maintenance_flag)
    - Use existing migration pattern with try/catch for column additions
    - _Requirements: All (data layer prerequisite)_

- [x] 2. HTTP Deep Checks — Content and Header Validation
  - [x] 2.1 Implement content-validator.js module
    - Create `content-validator.js` with `validateContentRules()` and `evaluateContent()` exports
    - Implement substring match (case-sensitive), JSON key existence (dot-notation), and regex pattern validation
    - Return failures array with failed rule details and reason
    - Handle empty body case and invalid JSON detection
    - Validate regex patterns and reject invalid ones
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Write property test for content validation
    - **Property 3: Content Validation Evaluation Completeness**
    - Generate random bodies, substring/json_key/regex rules
    - Verify every non-matching rule appears in failures array
    - Verify pass=true iff all rules match, pass=false iff any fails
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6**

  - [x] 2.3 Implement header-validator.js module
    - Create `header-validator.js` with `validateHeaderRules()`, `evaluateHeaders()`, and `getSecurityPreset()` exports
    - Implement presence, exact value, and contains substring validation types
    - Header name matching must be case-insensitive
    - Report each individual failure separately with header name, type, expected, and actual
    - Implement security presets: Strict-Transport-Security, Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 2.4 Write property test for header validation
    - **Property 4: Header Validation Case-Insensitive Matching**
    - Generate random header maps with varied casing and rule sets
    - Verify case-insensitive header name matching
    - Verify all individual failures reported independently
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5**

- [x] 3. HTTP Deep Checks — Synthetic Transactions
  - [x] 3.1 Implement synthetic.js module
    - Create `synthetic.js` with `validateTransactionConfig()`, `executeSyntheticTransaction()`, `getTransactionResults()` exports
    - Validate 2-20 steps, well-formed URLs (http/https), valid HTTP methods
    - Execute steps sequentially passing cookies/tokens/headers between steps
    - Record per-step response time, status code, pass/fail
    - Abort on failure recording zero-based failed step index and reason
    - Implement per-step timeout (default 10s) that aborts remaining steps
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 3.2 Write property test for synthetic transaction validation
    - **Property 1: Synthetic Transaction Validation Correctness**
    - Generate random step arrays (0-25 items), URL strings, HTTP methods
    - Verify acceptance iff 2-20 steps with valid URLs and methods
    - **Validates: Requirements 1.4, 1.6**

  - [ ]* 3.3 Write property test for synthetic transaction failure reporting
    - **Property 2: Synthetic Transaction Failure Reporting**
    - Generate mock HTTP responses with random failure points
    - Verify failed_step_index matches first failing step
    - Verify no results recorded for steps after failure
    - **Validates: Requirements 1.2, 1.5**

- [x] 4. HTTP Deep Checks — Certificate, DNS, and Redirect
  - [x] 4.1 Implement certificate-monitor.js module
    - Create `certificate-monitor.js` with `classifyCertificateSeverity()`, `calculateDaysRemaining()`, `evaluateCertificateAlerts()`, `validateThresholds()` exports
    - Default thresholds: 14d warning, 7d critical, 3d emergency
    - Support 1-10 custom thresholds per monitor (1-365 days, warning/critical/emergency)
    - Calculate days as whole calendar days from current UTC to expiry
    - Rate-limit alerts: one per threshold per monitor per 24-hour window
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 4.2 Write property test for certificate severity classification
    - **Property 5: Certificate Severity Classification**
    - Generate random days 0-365, random threshold configs (1-10 thresholds)
    - Verify correct severity returned based on threshold matching logic
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.7**

  - [x] 4.3 Implement dns-resolver.js module
    - Create `dns-resolver.js` with `resolveWithTiming()`, `isIPAddress()`, `computeDnsStats()` exports
    - Measure DNS resolution time separately in milliseconds
    - Record failure reasons: NXDOMAIN, timeout, SERVFAIL
    - 5-second timeout on DNS resolution
    - Return 0ms for IP address URLs (skip resolution)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 4.4 Write property test for DNS IP address detection
    - **Property 6: DNS Resolution IP Address Detection**
    - Generate random URLs with IPv4, IPv6, and hostnames
    - Verify 0ms returned for IP addresses, measurement performed for hostnames
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [x] 4.5 Implement redirect-tracker.js module
    - Create `redirect-tracker.js` with `followRedirects()` export
    - Follow redirect chain recording each hop (URL, status code, response time)
    - Abort at 10 hops with redirect loop error
    - Per-hop timeout of 10 seconds
    - Evaluate final destination status for overall check result (2xx=success, 4xx/5xx=failure)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 4.6 Write property test for redirect chain boundaries
    - **Property 7: Redirect Chain Boundary Enforcement**
    - Generate random hop counts (1-15), status codes
    - Verify abort at >10 hops with error
    - Verify final status determines overall result
    - **Validates: Requirements 6.3, 6.6**

- [x] 5. Checkpoint — HTTP Deep Checks complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Performance & Load Testing — Percentiles and Apdex
  - [x] 6.1 Implement percentile-calculator.js module
    - Create `percentile-calculator.js` with `computePercentile()`, `computeAllPercentiles()`, `isValidTimeWindow()` exports
    - Use nearest-rank method: index = ceil(p/100 * N) - 1
    - Support time windows: 1h, 6h, 24h, 7d, 30d
    - Return null for <20 data points
    - Only include successful checks in calculation
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 6.2 Write property test for percentile calculation
    - **Property 8: Percentile Calculation Nearest-Rank Correctness**
    - Generate random integer arrays (0-1000 elements)
    - Verify nearest-rank formula for arrays ≥20 elements
    - Verify null returned for arrays <20 elements
    - **Validates: Requirements 7.1, 7.3, 7.4**

  - [x] 6.3 Implement apdex-calculator.js module
    - Create `apdex-calculator.js` with `classifyResponse()`, `computeApdex()`, `getApdexLabel()`, `computeApdexFromResults()` exports
    - Formula: (satisfied + tolerating/2) / total, rounded to 2 decimal places
    - Satisfied: rt ≤ T; Tolerating: T < rt ≤ 4T; Frustrated: rt > 4T + failures
    - Default satisfied threshold: 500ms
    - Labels: Excellent (0.94-1.0), Good (0.85-0.93), Fair (0.70-0.84), Poor (0.50-0.69), Unacceptable (<0.50)
    - Return null if <20 results
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 6.4 Write property test for Apdex score formula
    - **Property 9: Apdex Score Formula Correctness**
    - Generate random response time arrays, random thresholds
    - Verify formula produces correct score and label classification
    - Verify null returned for <20 results
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6**

- [x] 7. Performance & Load Testing — Load Tester and Connection Detector
  - [x] 7.1 Implement load-tester.js module
    - Create `load-tester.js` with `runLoadTest()`, `computeLoadTestStats()`, `canRunLoadTest()` exports
    - Support 10-1000 concurrent requests with 30s per-request timeout
    - Record per-request response time, status code, error classification
    - Compute summary: avg response, p95, error rate, requests/second
    - Prevent concurrent tests on same monitor; auto-abort after 120s
    - Rate limit: 5 tests per user per 60 minutes
    - Mark result "degraded" if >50% requests fail
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 7.2 Implement connection-detector.js module
    - Create `connection-detector.js` with `runConnectionTest()`, `detectLimit()` exports
    - Increment by 10 from 10 to configurable max (default 500)
    - Send 20 requests per level; record status and response time per request
    - Stop when error rate >10% at a level
    - Produce summary: concurrency, avg response, error rate per level
    - Prevent concurrent tests on same monitor
    - Rate limit: 3 tests per user per hour
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 7.3 Implement geographic-checker.js module
    - Create `geographic-checker.js` with `runGeographicCheck()`, `computeConsensus()`, `validateRegionConfig()` exports
    - Execute checks from each region endpoint in parallel with 30s timeout
    - Record per-region response time and UP/DOWN status
    - Report partial outage when mixed results
    - Support 3-20 configurable region endpoints
    - Majority consensus: >50% UP = overall UP
    - Treat unreachable/timeout regions as DOWN
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [ ]* 7.4 Write property test for geographic consensus
    - **Property 10: Geographic Consensus Status**
    - Generate random UP/DOWN arrays (3-20 elements)
    - Verify UP when >50% UP, DOWN when ≥50% DOWN
    - Verify PARTIAL reported when at least one region differs
    - **Validates: Requirements 11.3, 11.5, 11.6**

- [x] 8. Checkpoint — Performance & Load Testing complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Alerting & Incidents — Escalation and Maintenance
  - [x] 9.1 Implement escalation-engine.js module
    - Create `escalation-engine.js` with `triggerEscalation()`, `acknowledgeAlert()`, `validateEscalationPolicy()` exports
    - Support 3-10 escalation tiers with configurable channel and delay (1-60 min)
    - Deliver first notification within 5 seconds of alert
    - Advance to next tier when delay elapses without acknowledgment
    - Cancel pending escalations on acknowledgment
    - Notify all channels on tier exhaustion
    - Retry failed delivery once after 30s; proceed to next tier if retry fails
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 9.2 Implement maintenance-window.js module
    - Create `maintenance-window.js` with `isWithinMaintenanceWindow()`, `validateMaintenanceWindow()`, `getActiveWindows()` exports
    - Support one-time and recurring (daily, weekly, monthly) schedules with timezone
    - Validate end > start, duration ≤ 24 hours
    - Continue executing checks during maintenance (flag results)
    - Resume alerting when window ends; trigger re-evaluation if monitor DOWN
    - Handle overlapping windows (suppress until all end)
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [ ]* 9.3 Write property test for maintenance window evaluation
    - **Property 11: Maintenance Window Time Evaluation**
    - Generate random time windows, current times, recurrence patterns
    - Verify active iff current time falls within window (accounting for recurrence)
    - Verify overlapping windows maintain suppression
    - **Validates: Requirements 13.1, 13.4, 13.6**

  - [x] 9.4 Implement alert-deduplicator.js module
    - Create `alert-deduplicator.js` with `shouldSuppress()`, `getSuppressedCount()`, `clearSuppression()` exports
    - Configurable suppression window (5-1440 minutes, default 30)
    - Suppress all alerts while monitor DOWN
    - Send reminder on window expiry if still DOWN, restart window
    - Clear suppression and send recovery on DOWN→UP
    - Track suppressed count per incident
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [ ]* 9.5 Write property test for alert deduplication
    - **Property 12: Alert Deduplication Suppression Logic**
    - Generate random timestamps and window sizes
    - Verify suppression when time since last alert < window
    - Verify reminder sent on window expiry + still DOWN
    - Verify suppression cleared on recovery
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4**

- [x] 10. Alerting & Incidents — Incidents, Status Page, and On-Call
  - [x] 10.1 Implement incident-timeline.js module
    - Create `incident-timeline.js` with `openIncident()`, `addTimelineEvent()`, `closeIncident()`, `calculateDowntime()` exports
    - Open incident on UP→DOWN transition (if no open incident exists)
    - Record events: failure_detected, retry_attempt, escalation_sent, acknowledged, recovery_detected
    - Close incident on DOWN→UP, calculate total downtime in seconds
    - Include response time measurements during incident
    - Log recovery without new incident if no open incident on DOWN→UP
    - Still create incidents during maintenance (flagged)
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [x] 10.2 Implement status-page-manager.js module
    - Create `status-page-manager.js` with `validateIncidentMessage()`, `createStatusIncident()`, `updateStatusIncident()`, `getActiveIncidents()`, `getResolvedIncidents()` exports
    - Support statuses: investigating, identified, monitoring, resolved
    - Validate title (1-200 chars), description (max 2000 chars)
    - Append updates preserving chronological history
    - Display active incidents above other content, ordered by most recent
    - Move resolved incidents to history (visible 7 days)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [ ]* 10.3 Write property test for status page message validation
    - **Property 18: Status Page Message Validation**
    - Generate random titles (0-300 chars), descriptions (0-3000 chars)
    - Verify acceptance for 1-200 char titles with ≤2000 char descriptions
    - Verify rejection for empty or >200 char titles
    - **Validates: Requirements 15.1, 15.6**

  - [x] 10.4 Implement on-call-scheduler.js module
    - Create `on-call-scheduler.js` with `getCurrentOnCall()`, `getNextOnCall()`, `validateRotationConfig()` exports
    - Maintain ordered list of 2-50 team members with contact details
    - Route alerts to current on-call based on rotation
    - Support rotation intervals: daily (24h), weekly (168h), custom (1-720h)
    - Advance round-robin on interval elapse, wrap to first after last
    - Support manual override until specified end time
    - Fallback to all system channels if no valid on-call member
    - Failover to next member on delivery failure within 60s
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7_

  - [ ]* 10.5 Write property test for on-call rotation
    - **Property 13: On-Call Rotation Round-Robin Correctness**
    - Generate random team sizes (2-50), intervals, time offsets
    - Verify index = floor((currentTime - startTime) / interval) % N
    - Verify correct wrap-around from last to first member
    - **Validates: Requirements 17.2, 17.3, 17.4**

- [x] 11. Checkpoint — Alerting & Incidents complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Logs & Diagnostics — Log Ingestion and Error Rate
  - [x] 12.1 Implement log-ingestion.js module
    - Create `log-ingestion.js` with `validateLogEntry()`, `validateLogBatch()`, `ingestLogs()`, `queryLogs()`, `purgeStaleLogs()` exports
    - Accept up to 100 entries per request authenticated via API key
    - Validate required fields: hostname, timestamp, severity, message
    - Reject entries exceeding 10KB message size (process others in same batch)
    - Support filtering by hostname, severity, time range, keyword
    - Paginate results (up to 100 per page, sorted by timestamp DESC)
    - Auto-purge entries older than 30 days every 6 hours
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

  - [ ]* 12.2 Write property test for log entry validation
    - **Property 14: Log Entry Validation Completeness**
    - Generate random log entries with varied fields and sizes
    - Verify entries missing required fields are rejected with specific errors
    - Verify entries >10KB rejected while valid entries in same batch accepted
    - **Validates: Requirements 18.1, 18.4, 18.6**

  - [x] 12.3 Implement error-rate-tracker.js module
    - Create `error-rate-tracker.js` with `recordErrorStatus()`, `getErrorCountInWindow()`, `isSpike()`, `getErrorRateHistory()` exports
    - Count 5xx responses per monitor in rolling 1-minute windows
    - Trigger spike alert when count exceeds threshold (default 5, configurable 1-100)
    - Send recovery notification when rate drops below threshold
    - Expose per-minute history for last 24 hours (1440 points max)
    - Record specific 5xx status codes for filtering
    - Suppress additional spike alerts while spike active
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

- [x] 13. Logs & Diagnostics — Traceroute, Screenshot, and Diff
  - [x] 13.1 Implement traceroute-runner.js module
    - Create `traceroute-runner.js` with `runTraceroute()`, `canRunTraceroute()` exports
    - Execute traceroute on check failure (after retries exhausted) with max 30 hops
    - Record each hop: sequence, IP, hostname (or "unknown"), RTT (or "no response")
    - Abort after 30 seconds, store partial results marked incomplete
    - Rate limit: 1 traceroute per monitor per 5 minutes
    - Graceful degradation if traceroute command unavailable
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6_

  - [x] 13.2 Implement screenshot-capture.js module
    - Create `screenshot-capture.js` with `captureScreenshot()`, `getScreenshotPath()`, `purgeOldScreenshots()` exports
    - Launch headless browser on check failure for screenshot-enabled monitors
    - Capture PNG at 1280x720 viewport
    - 15-second timeout; store timeout indicator if page doesn't load
    - Create `screenshots/` directory for storage
    - Auto-delete screenshots older than 30 days
    - Graceful degradation if Chromium unavailable
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_

  - [x] 13.3 Implement diff-detector.js module
    - Create `diff-detector.js` with `computeDiffPercentage()`, `computeContentHash()`, `shouldAlert()`, `applyExclusions()` exports
    - Character-level comparison of response body against stored baseline
    - Alert when diff exceeds configurable threshold (default 5%)
    - Store previous and current SHA-256 hash and changed line summary
    - Support exclusion patterns (regex) for dynamic content
    - Capture initial baseline on first enable without alerting
    - Skip comparison on check failure (retain existing baseline)
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7_

  - [ ]* 13.4 Write property test for content diff percentage
    - **Property 15: Content Diff Percentage Calculation**
    - Generate random string pairs and thresholds
    - Verify diff percentage = changed chars / baseline length × 100
    - Verify alert triggered when diff exceeds threshold
    - Verify exclusion patterns applied before comparison
    - **Validates: Requirements 22.1, 22.2, 22.5**

- [x] 14. Checkpoint — Logs & Diagnostics complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Dashboard & Visualization — WebSocket Service
  - [x] 15.1 Implement ws-service.js module
    - Create `ws-service.js` with `initWebSocket()`, `broadcast()`, `getConnectedClientCount()` exports
    - Establish WebSocket server alongside Express HTTP server using `ws` library
    - Ping every 30s, close connection if no pong within 10s
    - Broadcast check results and status changes within 2 seconds
    - Support client subscription to specific monitors or all
    - Allow subscription updates without disconnecting
    - Client reconnect: exponential backoff 1s→2s→4s→...→30s max, 10 attempts
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6_

- [x] 16. Dashboard & Visualization — Frontend Components
  - [x] 16.1 Implement SLA calculator (server-side module + API)
    - Create `sla-calculator.js` with `computeSLA()`, `computeErrorBudget()`, `validateSLATarget()` exports
    - Formula: (monitored - downtime) / monitored × 100, rounded to 3 decimal places
    - Accept targets 90.0-99.999; reject out-of-range values
    - Calculate error budget: allowed vs used downtime, remaining percentage, breach indicator
    - Support periods: monthly, quarterly, yearly
    - Display no-data indicator when no check data in period
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7_

  - [ ]* 16.2 Write property test for SLA calculation
    - **Property 16: SLA Calculation and Error Budget**
    - Generate random durations and downtime values (downtime ≤ monitored)
    - Verify SLA percentage formula and 3 decimal place rounding
    - Verify error budget remaining and breach detection
    - **Validates: Requirements 26.1, 26.3, 26.4**

  - [x] 16.3 Implement heatmap.js frontend component
    - Create `public/js/heatmap.js` for 90-day uptime calendar grid
    - Color scale: green (≥99.5%), light-green (95-99.4%), amber (80-94.9%), red (<80%), gray (no data)
    - Tooltip on hover/focus: date, uptime%, total checks, failures
    - Integrate into monitor detail view
    - Calculate per-day uptime using monitor's timezone (default UTC)
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6_

  - [ ]* 16.4 Write property test for heatmap color classification
    - **Property 17: Heatmap Color Classification**
    - Generate random percentages (0-100)
    - Verify correct color for each range boundary
    - **Validates: Requirements 24.1, 24.2**

  - [x] 16.5 Implement comparison.js frontend component
    - Create `public/js/comparison.js` for multi-monitor overlay chart
    - Support 2-10 monitors with distinct colored lines
    - Time windows: 1h, 6h, 24h, 7d (default 24h)
    - Shared Y-axis auto-scaled to min/max across all monitors
    - Legend with monitor name, color, "no data" label when applicable
    - Error message for <2 monitors selected
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7_

  - [x] 16.6 Implement custom-dashboard.js frontend component
    - Create `public/js/custom-dashboard.js` for drag-and-drop dashboard engine
    - Grid: 12 columns, widgets span 1-12 cols × 1-4 rows
    - Max 10 dashboards per user, max 20 widgets per dashboard
    - Widget types: monitor_status, response_chart, heatmap, apdex, sla, error_rate, comparison
    - HTML5 Drag API with CSS Grid positioning
    - Persist layout to SQLite as JSON, restore on login
    - Default dashboard when none configured
    - Display empty state for unavailable data source monitors
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9_

- [x] 17. Checkpoint — Dashboard & Visualization complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. API Routes and Integration Wiring
  - [x] 18.1 Add HTTP Deep Checks API routes to server.js
    - POST/GET/PUT/DELETE routes for synthetic transactions
    - POST/GET routes for content validation rules per monitor
    - POST/GET routes for header validation rules per monitor
    - GET route for certificate alert thresholds; PUT for custom thresholds
    - GET route for DNS stats in monitor analytics
    - GET route for redirect chain data in monitor detail
    - Wire content-validator and header-validator into existing check flow in monitor.js
    - Wire certificate-monitor into HTTPS check completion
    - Wire dns-resolver into check execution pipeline
    - Wire redirect-tracker into HTTP response handling
    - _Requirements: 1-6 (API integration)_

  - [x] 18.2 Add Performance & Load Testing API routes to server.js
    - GET route for percentiles in analytics endpoint
    - GET route for Apdex scores in analytics endpoint
    - POST route to trigger load test; GET for load test results
    - POST route to trigger connection test; GET for connection test results
    - POST/GET/PUT/DELETE routes for geographic region configuration
    - GET route for geographic check results
    - Wire percentile and apdex calculations into existing analytics
    - _Requirements: 7-11 (API integration)_

  - [x] 18.3 Add Alerting & Incidents API routes to server.js
    - POST/GET/PUT/DELETE routes for escalation policies
    - POST route to acknowledge alert
    - POST/GET/PUT/DELETE routes for maintenance windows
    - GET route for incident timelines and events
    - POST/GET/PUT routes for status page incidents and updates
    - GET/PUT routes for alert deduplication configuration
    - POST/GET/PUT/DELETE routes for on-call teams, members, and overrides
    - Wire escalation-engine into alert trigger flow
    - Wire maintenance-window check into notification pipeline
    - Wire alert-deduplicator into notification dispatch
    - Wire on-call-scheduler into notification routing
    - Wire incident-timeline into status change events in monitor.js
    - _Requirements: 12-17 (API integration)_

  - [x] 18.4 Add Logs & Diagnostics API routes to server.js
    - POST route for log ingestion (authenticated via API key)
    - GET route for log querying with filters and pagination
    - GET route for error rate history per monitor
    - GET route for traceroute results per check log entry
    - GET route for screenshot retrieval (serve file from filesystem)
    - GET route for diff results per monitor
    - POST route to update diff baseline
    - Wire traceroute-runner into check failure handler
    - Wire screenshot-capture into check failure handler
    - Wire diff-detector into successful check pipeline
    - Wire error-rate-tracker into check result recording
    - Set up purge schedulers (logs, screenshots, error events)
    - _Requirements: 18-22 (API integration)_

  - [x] 18.5 Add Dashboard & Visualization API routes and WebSocket integration
    - Initialize WebSocket service in server.js startup
    - GET/POST/PUT/DELETE routes for custom dashboards and widgets
    - GET route for SLA calculations per monitor
    - PUT route for SLA target configuration
    - GET route for heatmap data (90-day per-day uptime)
    - GET route for comparison data (multi-monitor response times)
    - Wire ws-service broadcast into check result recording and status changes
    - Serve static frontend JS files from public/js/ directory
    - _Requirements: 23-27 (API integration)_

- [ ] 19. Integration into Existing Check Engine (monitor.js)
  - [ ] 19.1 Extend monitor.js check execution pipeline
    - Import and wire dns-resolver to measure DNS time before HTTP request
    - Import and wire redirect-tracker for 3xx responses
    - Import and wire content-validator to run after successful HTTP response
    - Import and wire header-validator to run after successful HTTP response
    - Import and wire certificate-monitor for HTTPS connections
    - Store dns_time_ms in logs table, maintenance_flag when applicable
    - Import and wire error-rate-tracker to record 5xx responses
    - Import and wire traceroute-runner on failure (after retries)
    - Import and wire screenshot-capture on failure (if enabled)
    - Import and wire diff-detector on success (if enabled)
    - Trigger incident-timeline events on status transitions
    - Broadcast results via ws-service
    - Check maintenance-window before alert dispatch
    - Route alerts through alert-deduplicator and escalation-engine
    - _Requirements: 1-6, 19, 20, 21, 22, 23 (pipeline integration)_

- [ ] 20. Final checkpoint — Full integration complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between major subsystems
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses JavaScript (Node.js) matching the existing codebase
- All new modules are ES modules (export/import) consistent with existing code
- SQLite schema changes are additive (backward compatible with existing data)
- Frontend components are vanilla JS files served statically (no build step)
- WebSocket uses the `ws` library alongside the existing Express server
- Screenshots stored on filesystem under `screenshots/` directory
- Purge operations run on intervals to manage storage growth

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.3", "4.1", "4.3", "4.5", "6.1", "6.3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1", "4.2", "4.4", "4.6", "6.2", "6.4"] },
    { "id": 3, "tasks": ["3.2", "3.3", "7.1", "7.2", "7.3", "9.1", "9.2", "9.4"] },
    { "id": 4, "tasks": ["7.4", "9.3", "9.5", "10.1", "10.2", "10.4", "12.1", "12.3"] },
    { "id": 5, "tasks": ["10.3", "10.5", "12.2", "13.1", "13.2", "13.3", "15.1"] },
    { "id": 6, "tasks": ["13.4", "16.1", "16.3", "16.5", "16.6"] },
    { "id": 7, "tasks": ["16.2", "16.4", "18.1", "18.2"] },
    { "id": 8, "tasks": ["18.3", "18.4", "18.5"] },
    { "id": 9, "tasks": ["19.1"] }
  ]
}
```
