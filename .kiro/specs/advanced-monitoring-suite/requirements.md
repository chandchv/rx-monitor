# Requirements Document

## Introduction

This document defines the requirements for the Advanced Monitoring Suite expansion of the RxMonitor application. The expansion covers five major capability areas: HTTP Deep Checks (synthetic transactions, content/header validation, certificate and DNS monitoring), Performance & Load Testing (percentiles, Apdex, load tests, geographic checks), Alerting & Incidents (escalation policies, maintenance windows, incident timelines, deduplication, on-call rotation), Logs & Diagnostics (centralized log ingestion, error rate tracking, traceroute, screenshots, diff detection), and Dashboard & Visualization (real-time WebSocket charts, heatmaps, comparison views, SLA calculator, custom dashboards).

## Glossary

- **Check_Engine**: The core monitoring subsystem responsible for executing HTTP checks, measuring response times, and recording results to the database.
- **Synthetic_Transaction**: A multi-step HTTP check that simulates a user workflow by executing a sequence of HTTP requests where each step may depend on the response of the previous step.
- **Content_Validator**: The subsystem responsible for asserting that HTTP response bodies contain expected strings, JSON keys, or regex patterns.
- **Header_Validator**: The subsystem responsible for verifying the presence and correctness of HTTP response headers.
- **Certificate_Monitor**: The subsystem that tracks SSL/TLS certificate expiration dates and generates alerts at configurable thresholds.
- **DNS_Resolver**: The subsystem that measures DNS resolution time independently from overall HTTP response time.
- **Redirect_Tracker**: The subsystem that follows and records the full HTTP redirect chain for a given URL.
- **Percentile_Calculator**: The subsystem that computes response time percentiles (p50, p95, p99) over configurable time windows.
- **Apdex_Calculator**: The subsystem that computes Application Performance Index scores based on configurable satisfied/tolerating thresholds.
- **Load_Tester**: The subsystem that generates controlled bursts of concurrent HTTP requests to measure degradation under load.
- **Connection_Detector**: The subsystem that gradually increases concurrent connections to a target until errors are detected, identifying connection limits.
- **Geographic_Checker**: The subsystem that executes checks from multiple geographic regions and aggregates regional results.
- **Escalation_Engine**: The subsystem that manages tiered notification delivery with configurable delays between escalation levels.
- **Maintenance_Window**: A scheduled time period during which alert notifications are suppressed for designated monitors.
- **Incident_Timeline**: An auto-generated chronological record of an outage event including timestamps, response times, and recovery details.
- **Status_Page_Manager**: The subsystem responsible for creating and managing public-facing incident messages on the status page.
- **Alert_Deduplicator**: The subsystem that suppresses redundant alert notifications for the same ongoing outage event.
- **On_Call_Scheduler**: The subsystem that manages round-robin rotation of notification recipients.
- **Log_Ingestion_Service**: The subsystem that receives, stores, and indexes log entries pushed from remote servers.
- **Error_Rate_Tracker**: The subsystem that counts HTTP 5xx responses per time window and triggers alerts on rate spikes.
- **Traceroute_Runner**: The subsystem that automatically executes network traceroute diagnostics when a check failure is detected.
- **Screenshot_Capture**: The subsystem that uses a headless browser to capture a visual snapshot of a monitored page upon check failure.
- **Diff_Detector**: The subsystem that compares page content across checks and alerts when unexpected changes are detected.
- **WebSocket_Service**: The real-time communication layer that pushes live monitoring data to connected dashboard clients.
- **Heatmap_Renderer**: The frontend subsystem that displays uptime data as a calendar-style heatmap visualization.
- **Comparison_View**: The dashboard component that overlays response time data from multiple monitors onto a single chart.
- **SLA_Calculator**: The subsystem that computes actual uptime percentages against configured SLA targets and displays remaining error budget.
- **Custom_Dashboard_Engine**: The subsystem that allows users to create personalized dashboard layouts with drag-and-drop widgets.

---

## Requirements

### Requirement 1: Multi-Step Synthetic Transactions

**User Story:** As a monitoring administrator, I want to define multi-step HTTP check sequences that simulate user workflows, so that I can verify that authenticated or multi-page flows are functioning correctly.

#### Acceptance Criteria

1. WHEN a Synthetic_Transaction is configured with an ordered list of between 2 and 20 HTTP steps, THE Check_Engine SHALL execute each step sequentially, passing response data (cookies, tokens, headers) from one step to the next.
2. WHEN any step in a Synthetic_Transaction returns an HTTP status code outside the 200-299 range or fails to match its configured validation criteria, THE Check_Engine SHALL mark the entire transaction as failed and record the zero-based step index that failed along with the failure reason.
3. THE Check_Engine SHALL record the individual response time in milliseconds, HTTP status code, and pass/fail result for each step within a Synthetic_Transaction.
4. WHEN a Synthetic_Transaction is created, THE Check_Engine SHALL validate that between 2 and 20 steps are defined and that each step contains a well-formed URL with an http or https scheme and a valid HTTP method (GET, POST, PUT, DELETE, PATCH, or HEAD).
5. IF a step in a Synthetic_Transaction does not receive a complete response within the configured per-step timeout (default: 10 seconds), THEN THE Check_Engine SHALL abort all remaining steps and record a timeout failure with the zero-based step index.
6. IF a Synthetic_Transaction is configured with more than 20 steps, THEN THE Check_Engine SHALL reject the configuration and return an error indicating the maximum step limit has been exceeded.

---

### Requirement 2: Content Validation

**User Story:** As a monitoring administrator, I want to validate that HTTP response bodies contain expected content, so that I can detect application errors even when the HTTP status code is 200.

#### Acceptance Criteria

1. WHEN a monitor has content validation rules configured, THE Content_Validator SHALL check the response body against each rule after a successful HTTP response is received.
2. THE Content_Validator SHALL support three validation types: case-sensitive plain text substring match, JSON key existence check (using dot-notation for nested keys), and regex pattern match.
3. WHEN the response body fails any configured content validation rule, THE Content_Validator SHALL mark the check as failed and record which validation rule was not satisfied along with the expected value.
4. IF the response body is empty and content validation rules are configured, THEN THE Content_Validator SHALL mark the check as failed with a descriptive error message indicating an empty response.
5. IF a configured regex pattern is invalid, THEN THE Content_Validator SHALL reject the monitor configuration and return an error indicating the invalid regex pattern.
6. IF a JSON key existence check is configured and the response body is not valid JSON, THEN THE Content_Validator SHALL mark the check as failed with an error indicating the response is not valid JSON.

---

### Requirement 3: Security Header Validation

**User Story:** As a security-conscious administrator, I want to verify that my servers return required security headers, so that I can detect misconfigurations that weaken security posture.

#### Acceptance Criteria

1. WHEN a monitor has header validation rules configured and an HTTP response is received with a 2xx status code, THE Header_Validator SHALL inspect the response headers against each configured rule.
2. THE Header_Validator SHALL support three validation types: header presence (header exists regardless of value), header exact value match (case-sensitive comparison of the full header value), and header value contains substring (case-sensitive substring search within the header value). Header name matching SHALL be case-insensitive.
3. THE Header_Validator SHALL provide built-in presets for common security headers that validate header presence: Strict-Transport-Security, Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, and Referrer-Policy. WHEN an administrator applies a preset, THE Header_Validator SHALL populate the validation rules for those headers with presence-type checks that the administrator may then customize.
4. WHEN a required header is missing or does not match the expected value, THE Header_Validator SHALL mark the check as failed and record a header validation failure with the specific header name, the validation type that failed, and the expected versus actual values.
5. WHEN multiple header validation rules are configured and more than one rule fails, THE Header_Validator SHALL record each individual failure separately so that all non-compliant headers are reported in a single check result.

---

### Requirement 4: Certificate Expiry Monitoring Enhancement

**User Story:** As a system administrator, I want granular SSL certificate expiry alerts at 14, 7, and 3 days before expiration, so that I have multiple escalating warnings to renew certificates in time.

#### Acceptance Criteria

1. WHEN a successful HTTPS monitor check is completed, THE Certificate_Monitor SHALL extract the SSL certificate expiration date via the TLS connection and store it associated with that monitor.
2. WHEN a certificate has 14 or fewer days until expiration and more than 7 days remaining, THE Certificate_Monitor SHALL generate a warning-level alert.
3. WHEN a certificate has 7 or fewer days until expiration and more than 3 days remaining, THE Certificate_Monitor SHALL generate a critical-level alert.
4. WHEN a certificate has 3 or fewer days until expiration (including already-expired certificates), THE Certificate_Monitor SHALL generate an emergency-level alert.
5. THE Certificate_Monitor SHALL allow administrators to configure between 1 and 10 custom expiry alert thresholds per monitor, each specifying a days-remaining value (between 1 and 365) and a severity level (warning, critical, or emergency); when custom thresholds are configured they SHALL replace the default 14/7/3 day thresholds for that monitor.
6. THE Certificate_Monitor SHALL send at most one alert per threshold level per monitor within a rolling 24-hour window to prevent notification flooding.
7. THE Certificate_Monitor SHALL calculate days until expiration as the number of whole calendar days remaining from the current UTC date to the certificate expiration date.

---

### Requirement 5: DNS Resolution Time Measurement

**User Story:** As a network administrator, I want to measure DNS resolution time separately from HTTP response time, so that I can identify whether slowness is caused by DNS or the target server.

#### Acceptance Criteria

1. WHEN executing an HTTP check for a monitor whose URL contains a hostname, THE DNS_Resolver SHALL measure and record the time spent resolving the target hostname to an IP address separately from the total response time.
2. THE DNS_Resolver SHALL store DNS resolution time as an integer in milliseconds alongside the existing response time metric for each check log entry.
3. WHEN DNS resolution fails, THE DNS_Resolver SHALL record the failure reason (NXDOMAIN, timeout, SERVFAIL) as a distinct error type and mark the check as failed.
4. IF DNS resolution does not complete within 5 seconds, THEN THE DNS_Resolver SHALL abort the resolution attempt and record a DNS timeout failure.
5. IF the monitor URL contains an IP address instead of a hostname, THEN THE DNS_Resolver SHALL record a DNS resolution time of 0 milliseconds and proceed directly to the HTTP request.
6. THE DNS_Resolver SHALL expose DNS resolution time metrics in the monitor analytics API endpoint, including average, minimum, and maximum DNS resolution times for the requested time window.

---

### Requirement 6: Redirect Chain Tracking

**User Story:** As a web administrator, I want to see the full redirect chain for my monitored URLs, so that I can identify unnecessary redirects and diagnose redirect loops.

#### Acceptance Criteria

1. WHEN an HTTP response contains a redirect status code (3xx), THE Redirect_Tracker SHALL follow the redirect chain and record each hop including the target URL, HTTP status code, and response time in milliseconds.
2. THE Redirect_Tracker SHALL store the complete redirect chain associated with each individual check that encounters redirects, preserving hop order from first redirect to final destination.
3. IF a redirect chain exceeds 10 hops, THEN THE Redirect_Tracker SHALL abort following redirects and mark the check as failed with a redirect loop error indicating the number of hops followed.
4. THE Redirect_Tracker SHALL expose redirect chain data through the monitor detail API endpoint for each check log entry that contains redirect hops.
5. IF any individual hop in the redirect chain does not respond within 10 seconds, THEN THE Redirect_Tracker SHALL abort the redirect chain and mark the check as failed with a timeout error indicating the hop URL that timed out.
6. WHEN the redirect chain completes successfully, THE Redirect_Tracker SHALL evaluate the final destination response status to determine the overall check result (success for 2xx, failure for 4xx or 5xx).

---

### Requirement 7: Response Time Percentiles

**User Story:** As a performance engineer, I want to see p50, p95, and p99 response time percentiles over time, so that I can understand the distribution of response times rather than relying solely on averages.

#### Acceptance Criteria

1. THE Percentile_Calculator SHALL compute p50, p95, and p99 response time percentiles from stored check logs for configurable time windows (1 hour, 6 hours, 24 hours, 7 days, 30 days), including only successful checks in the calculation.
2. WHEN the analytics endpoint is queried for a specific monitor, THE Percentile_Calculator SHALL return percentile values alongside existing average, min, and max metrics.
3. THE Percentile_Calculator SHALL require a minimum of 20 successful data points within the time window before calculating percentiles; below this threshold it SHALL return null for percentile values.
4. THE Percentile_Calculator SHALL compute percentiles using the nearest-rank method.
5. IF an invalid time window is requested, THEN THE Percentile_Calculator SHALL return an error indicating the valid time window options.

---

### Requirement 8: Apdex Score Calculation

**User Story:** As a product owner, I want an Apdex user satisfaction score for each monitor, so that I can quickly assess whether response times meet user expectations.

#### Acceptance Criteria

1. THE Apdex_Calculator SHALL compute Apdex scores using the formula: (satisfied_count + tolerating_count / 2) / total_count, rounded to two decimal places, for configurable time windows (1 hour, 6 hours, 24 hours, 7 days, 30 days).
2. THE Apdex_Calculator SHALL use configurable thresholds where responses at or below the satisfied threshold count as satisfied, responses above satisfied but at or below 4x the satisfied threshold count as tolerating, and responses above 4x the satisfied threshold count as frustrated.
3. THE Apdex_Calculator SHALL default the satisfied threshold to 500 milliseconds when no custom threshold is configured.
4. WHEN the Apdex score is returned, THE Apdex_Calculator SHALL include a classification label: Excellent (0.94-1.0), Good (0.85-0.93), Fair (0.70-0.84), Poor (0.50-0.69), or Unacceptable (below 0.50).
5. THE Apdex_Calculator SHALL classify failed checks (timeouts, connection errors, non-success HTTP status codes) as frustrated responses when computing the Apdex score.
6. IF fewer than 20 check results exist within the selected time window, THEN THE Apdex_Calculator SHALL return null for the Apdex score instead of computing a value.

---

### Requirement 9: On-Demand Load Testing

**User Story:** As a performance engineer, I want to trigger a burst of concurrent requests to a target endpoint, so that I can measure how my server degrades under load.

#### Acceptance Criteria

1. WHEN a load test is triggered, THE Load_Tester SHALL send a configurable number of concurrent HTTP requests (between 10 and 1000) to the target monitor URL, applying a per-request timeout of 30 seconds after which the individual request is marked as failed.
2. THE Load_Tester SHALL record individual response times, status codes, and error classifications for each request in the burst, where a request is classified as failed if it results in a connection error, a timeout, or a non-2xx HTTP status code.
3. THE Load_Tester SHALL compute summary statistics after the burst completes: average response time, p95 response time, error rate percentage, and requests per second achieved.
4. WHILE a load test is in progress, THE Load_Tester SHALL prevent triggering additional load tests on the same monitor, and SHALL automatically abort the test if it has not completed within 120 seconds, recording partial results collected up to that point.
5. IF a user exceeds 5 load tests within a rolling 60-minute window, THEN THE Load_Tester SHALL reject the request with an error message indicating the rate limit has been reached and the time remaining until the next test is allowed.
6. IF more than 50 percent of requests in a load test fail, THEN THE Load_Tester SHALL mark the result as "degraded" in the test summary.

---

### Requirement 10: Concurrent Connection Limit Detection

**User Story:** As a system administrator, I want to detect the maximum concurrent connections my server can handle before errors occur, so that I can capacity plan and configure connection limits appropriately.

#### Acceptance Criteria

1. WHEN a connection limit test is triggered, THE Connection_Detector SHALL gradually increase concurrent connections in increments of 10 starting from 10 up to a configurable maximum (default: 500), sending 20 requests at each concurrency level to establish a statistically meaningful error rate.
2. THE Connection_Detector SHALL record the response status and individual response time for each request at each concurrency level, classifying a request as an error if it returns an HTTP 5xx status code, a connection refusal, or exceeds a 10-second timeout.
3. WHEN the error rate at a concurrency level exceeds 10 percent of the 20 requests sent at that level, THE Connection_Detector SHALL stop the test and report that concurrency level as the detected connection limit.
4. THE Connection_Detector SHALL produce a summary report showing concurrency level, average response time, and error rate percentage at each tested level.
5. WHILE a connection limit test is in progress for a monitor, THE Connection_Detector SHALL reject additional connection limit test requests for the same monitor.
6. THE Connection_Detector SHALL enforce a rate limit of 3 connection limit tests per user per hour to prevent abuse.

---

### Requirement 11: Geographic Multi-Region Checks

**User Story:** As a global service owner, I want to check my endpoints from multiple geographic regions, so that I can detect region-specific outages and latency issues.

#### Acceptance Criteria

1. WHEN a monitor is configured for geographic checking, THE Geographic_Checker SHALL execute the check from each configured region endpoint in parallel, applying a per-region timeout of 30 seconds.
2. THE Geographic_Checker SHALL record per-region response time in milliseconds and UP/DOWN status for each check cycle.
3. WHEN a monitor is marked as UP from some regions and DOWN from others, THE Geographic_Checker SHALL report a partial outage status with the list of regions reporting DOWN.
4. THE Geographic_Checker SHALL support between 3 and 20 configurable region endpoints per monitor.
5. THE Geographic_Checker SHALL aggregate regional results and report the overall status based on majority consensus (more than 50 percent of regions report UP for overall UP status).
6. IF a region endpoint is unreachable or fails to respond within the timeout, THEN THE Geographic_Checker SHALL treat that region as DOWN for the current check cycle and include it in the aggregation result.

---

### Requirement 12: Escalation Policies

**User Story:** As an operations team lead, I want to define tiered notification escalation, so that critical alerts reach the right people at the right time if initial notifications are not acknowledged.

#### Acceptance Criteria

1. WHEN an alert is triggered and an escalation policy is configured, THE Escalation_Engine SHALL deliver the first notification via the first configured channel within 5 seconds of the alert being triggered.
2. WHEN the configured delay period elapses without acknowledgment, THE Escalation_Engine SHALL escalate to the next notification tier, where the delay interval is configurable between 1 and 60 minutes per tier.
3. THE Escalation_Engine SHALL support between 3 and 10 escalation tiers, each with an independently configurable notification channel (Telegram, email) and delay interval (1 to 60 minutes).
4. WHEN a user acknowledges an alert via the dashboard or API, THE Escalation_Engine SHALL cancel all pending escalation timers for that alert and stop further escalation.
5. IF all escalation tiers are exhausted without acknowledgment, THEN THE Escalation_Engine SHALL log an unacknowledged escalation event and notify all configured channels simultaneously.
6. IF notification delivery fails at any escalation tier, THEN THE Escalation_Engine SHALL retry delivery once after 30 seconds, and if the retry also fails, SHALL proceed to the next escalation tier without waiting for the full delay period.

---

### Requirement 13: Maintenance Windows

**User Story:** As a deployment engineer, I want to schedule maintenance windows during which alerts are suppressed, so that planned deployments do not generate false-positive notifications.

#### Acceptance Criteria

1. WHEN the current time falls within an active Maintenance_Window for a monitor, THE Escalation_Engine SHALL suppress all alert notifications for that monitor and cancel any in-progress escalation sequences for that monitor.
2. THE Maintenance_Window SHALL support both one-time and recurring schedule definitions (daily, weekly, monthly) with a specified timezone for each window.
3. WHEN a Maintenance_Window is created, THE system SHALL validate that the end time is after the start time and that the duration does not exceed 24 hours; IF validation fails, THEN THE system SHALL reject the creation and return an error message indicating which validation rule was violated.
4. WHILE a Maintenance_Window is active for a monitor, THE Check_Engine SHALL continue executing checks and record results with a maintenance flag.
5. WHEN a Maintenance_Window ends, THE Escalation_Engine SHALL resume normal alerting behavior and, IF the monitor is currently in a failed state, THEN THE Escalation_Engine SHALL trigger a new alert evaluation for that monitor.
6. IF multiple Maintenance_Windows overlap for the same monitor, THEN THE Escalation_Engine SHALL continue suppressing alerts until all overlapping windows have ended.

---

### Requirement 14: Incident Timeline Generation

**User Story:** As an incident responder, I want auto-generated incident timelines with all relevant data points, so that I can conduct postmortem reviews without manually assembling information.

#### Acceptance Criteria

1. WHEN a monitor transitions from UP to DOWN, THE Incident_Timeline SHALL create a new incident record with the timestamp of the first failed check and begin collecting timeline events, provided no open incident already exists for that monitor.
2. THE Incident_Timeline SHALL record the following events with ISO 8601 timestamps (second precision): initial failure detection, each retry attempt, escalation notifications sent, acknowledgment received, and recovery detection.
3. WHEN a monitor transitions from DOWN to UP, THE Incident_Timeline SHALL close the incident and calculate total downtime duration in seconds, measured from the initial failure detection timestamp to the recovery detection timestamp.
4. THE Incident_Timeline SHALL be retrievable via the API with all associated events ordered chronologically, returning a maximum of 1000 events per incident.
5. THE Incident_Timeline SHALL include response time measurements in milliseconds at each check during the incident period.
6. IF a monitor transitions from DOWN to UP and no open incident record exists for that monitor, THEN THE Incident_Timeline SHALL log a recovery event without creating a new incident record.
7. WHILE a Maintenance_Window is active for a monitor, THE Incident_Timeline SHALL still create and populate incident records for status transitions, flagged as occurring during maintenance.

---

### Requirement 15: Status Page Incident Messages

**User Story:** As a communications manager, I want to publish public-facing incident messages on the status page, so that users are informed about ongoing issues without needing direct support contact.

#### Acceptance Criteria

1. WHEN an administrator creates a status page incident, THE Status_Page_Manager SHALL display the incident message on the public status page with a title (maximum 200 characters), description (maximum 2000 characters), incident status, and creation timestamp.
2. THE Status_Page_Manager SHALL support incident status levels: investigating, identified, monitoring, and resolved.
3. WHEN an incident is updated, THE Status_Page_Manager SHALL append the update (maximum 2000 characters) to the incident history with a timestamp, while preserving all previous updates in chronological order.
4. THE Status_Page_Manager SHALL display active incidents above all other status page content, ordered by most recent creation timestamp first.
5. WHEN an incident is marked as resolved, THE Status_Page_Manager SHALL move the incident to a resolved history section visible for 7 days, after which it SHALL no longer appear on the public status page.
6. IF an administrator attempts to create an incident without a title or with a title exceeding 200 characters, THEN THE Status_Page_Manager SHALL reject the request and display an error message indicating the validation failure.

---

### Requirement 16: Alert Deduplication

**User Story:** As an on-call engineer, I want duplicate alert notifications suppressed during an ongoing outage, so that I am not overwhelmed with repeated messages about the same issue.

#### Acceptance Criteria

1. WHILE a monitor has a status of DOWN, THE Alert_Deduplicator SHALL suppress all subsequent alert notifications for that monitor regardless of specific error message changes.
2. THE Alert_Deduplicator SHALL use a configurable suppression window (minimum: 5 minutes, maximum: 1440 minutes, default: 30 minutes) during which duplicate alerts are not sent.
3. WHEN the suppression window expires and the monitor still has a status of DOWN, THE Alert_Deduplicator SHALL send a single reminder notification indicating the outage is ongoing, then restart the suppression window.
4. WHEN the monitor transitions from DOWN to UP, THE Alert_Deduplicator SHALL clear the suppression state and send the recovery notification within the next check cycle.
5. THE Alert_Deduplicator SHALL record a count of suppressed notifications per incident, and include the suppressed count in each reminder notification.

---

### Requirement 17: On-Call Rotation

**User Story:** As a team manager, I want round-robin on-call scheduling, so that alert notification responsibility is distributed fairly among team members.

#### Acceptance Criteria

1. THE On_Call_Scheduler SHALL maintain an ordered list of at least 2 and at most 50 team members with their notification contact details (Telegram chat ID, email address).
2. WHEN an alert is triggered, THE On_Call_Scheduler SHALL route the notification to the current on-call team member based on the rotation schedule.
3. THE On_Call_Scheduler SHALL support configurable rotation intervals: daily (24 hours), weekly (168 hours), or custom hour-based intervals between 1 hour and 720 hours.
4. WHEN a rotation interval elapses, THE On_Call_Scheduler SHALL advance to the next team member in the ordered list, wrapping to the first member after the last.
5. THE On_Call_Scheduler SHALL allow manual override to assign a specific team member as on-call until a specified end time or until explicitly cancelled, after which the rotation SHALL resume from the next scheduled member in sequence.
6. IF an alert is triggered and the on-call team member list is empty or no team member has valid contact details configured, THEN THE On_Call_Scheduler SHALL send the notification to all configured system-level notification channels and log an error indicating no on-call member is available.
7. IF the current on-call team member's notification delivery fails, THEN THE On_Call_Scheduler SHALL attempt to notify the next member in the rotation order within 60 seconds.

---

### Requirement 18: Centralized Log Ingestion

**User Story:** As a DevOps engineer, I want remote servers to push application logs to a central dashboard, so that I can search and filter logs across my infrastructure from one place.

#### Acceptance Criteria

1. WHEN a remote server sends log entries to the ingestion API endpoint, THE Log_Ingestion_Service SHALL store each entry with source hostname, timestamp, severity level (one of: debug, info, warn, error, fatal), and message content, accepting up to 100 entries per request.
2. THE Log_Ingestion_Service SHALL accept log entries authenticated via the existing API key mechanism.
3. THE Log_Ingestion_Service SHALL support filtering stored logs by hostname, severity level, time range, and keyword substring search, returning results paginated in pages of up to 100 entries sorted by timestamp descending.
4. IF a log entry exceeds the maximum message size of 10 kilobytes, THEN THE Log_Ingestion_Service SHALL reject that entry with an error response indicating the size limit was exceeded while still processing other valid entries in the same request.
5. THE Log_Ingestion_Service SHALL automatically purge log entries older than 30 days, running the purge process every 6 hours.
6. IF a log entry is missing any required field (hostname, timestamp, severity level, or message), THEN THE Log_Ingestion_Service SHALL reject that entry with an error response identifying the missing field.

---

### Requirement 19: Error Rate Tracking

**User Story:** As a reliability engineer, I want to track HTTP 5xx error rates per minute and receive alerts on spikes, so that I can detect server-side issues before they become full outages.

#### Acceptance Criteria

1. THE Error_Rate_Tracker SHALL count HTTP 5xx responses (status codes 500-599) per monitor within rolling 1-minute windows.
2. WHEN the 5xx error count within a rolling 1-minute window exceeds a configurable threshold (default: 5 errors per minute, configurable between 1 and 100), THE Error_Rate_Tracker SHALL trigger an error rate spike alert via the existing notification system.
3. WHEN the 5xx error count drops back to or below the configured threshold after a spike alert has been triggered, THE Error_Rate_Tracker SHALL send a recovery notification indicating the error rate has returned to normal.
4. THE Error_Rate_Tracker SHALL expose error rate history via the analytics API endpoint with per-minute granularity for the last 24 hours (1440 data points maximum), returning a count of zero for minutes with no 5xx errors.
5. THE Error_Rate_Tracker SHALL record the specific 5xx status code (500, 502, 503, 504, and any other 5xx code) for each error response, allowing filtering by individual status code in the recorded data.
6. WHILE an error rate spike alert is active for a monitor, THE Error_Rate_Tracker SHALL suppress additional spike alerts for that same monitor until the rate drops below the threshold and a recovery notification is sent.

---

### Requirement 20: Automatic Traceroute on Failure

**User Story:** As a network administrator, I want automatic traceroute execution when a check fails, so that I can identify where in the network path the failure occurs without manual intervention.

#### Acceptance Criteria

1. WHEN a monitor check fails after exhausting all retries, THE Traceroute_Runner SHALL automatically execute a traceroute to the target hostname with a maximum of 30 hops.
2. THE Traceroute_Runner SHALL store the complete traceroute output associated with the failed check log entry, recording each hop's sequence number, IP address, hostname (or "unknown" if reverse DNS fails), and round-trip time in milliseconds (or a "no response" indicator for hops that do not reply).
3. IF the traceroute execution exceeds 30 seconds, THEN THE Traceroute_Runner SHALL abort the traceroute and store the partial results collected up to that point, marked as incomplete.
4. THE Traceroute_Runner SHALL execute at most one traceroute per monitor per 5-minute window; IF a check failure occurs within the rate-limit window of a previous traceroute for the same monitor, THEN THE Traceroute_Runner SHALL skip the traceroute and log that it was suppressed due to rate limiting.
5. THE Traceroute_Runner SHALL expose stored traceroute results through the monitor detail API endpoint, associated with the corresponding failed check log entry.
6. IF the traceroute system command is unavailable or fails to execute, THEN THE Traceroute_Runner SHALL log the error and continue without blocking the check result recording.

---

### Requirement 21: Screenshot on Failure

**User Story:** As a web administrator, I want automatic screenshots captured when a web page check fails, so that I can visually inspect what the page looked like during the incident.

#### Acceptance Criteria

1. WHEN an HTTP check fails for a monitor configured for screenshot capture (after all retries are exhausted), THE Screenshot_Capture SHALL launch a headless browser and capture a viewport screenshot of the target URL.
2. THE Screenshot_Capture SHALL store the screenshot as a PNG image associated with the failed check log entry and make it retrievable via the API.
3. THE Screenshot_Capture SHALL complete the capture within 15 seconds; if the page does not load within this duration, it SHALL store a timeout indicator instead of a screenshot.
4. THE Screenshot_Capture SHALL capture screenshots at a viewport resolution of 1280x720 pixels.
5. IF the headless browser is unavailable or encounters an error, THEN THE Screenshot_Capture SHALL log the error and continue without blocking the check result recording.
6. THE Screenshot_Capture SHALL automatically delete stored screenshots older than 30 days to manage storage.

---

### Requirement 22: Content Diff Detection

**User Story:** As a security administrator, I want alerts when monitored page content changes unexpectedly, so that I can detect defacement, unauthorized modifications, or accidental deployments.

#### Acceptance Criteria

1. WHEN a monitor has diff detection enabled and the check returns a successful response, THE Diff_Detector SHALL compare the current response body against the previously stored baseline content using a character-level comparison.
2. WHEN the content differs from the baseline by more than a configurable threshold (default: 5 percent of baseline content length), THE Diff_Detector SHALL trigger a content change alert.
3. THE Diff_Detector SHALL store both the previous and current content SHA-256 hash and a summary listing the line numbers and character count of changed sections.
4. THE Diff_Detector SHALL allow administrators to manually update the baseline to accept intentional changes via the API or dashboard.
5. THE Diff_Detector SHALL ignore configurable elements (specified CSS selectors or regex patterns) to exclude dynamic content like timestamps or session tokens from comparison.
6. WHEN diff detection is first enabled for a monitor, THE Diff_Detector SHALL capture the response body from the next successful check as the initial baseline without triggering an alert.
7. IF a check fails (non-2xx response or connection error), THEN THE Diff_Detector SHALL skip the diff comparison for that check cycle and retain the existing baseline.

---

### Requirement 23: Real-Time WebSocket Dashboard

**User Story:** As a monitoring operator, I want live-updating dashboard charts without page refresh, so that I can observe system status changes in real time.

#### Acceptance Criteria

1. THE WebSocket_Service SHALL establish persistent WebSocket connections with connected dashboard clients and send a ping frame every 30 seconds to detect unresponsive connections.
2. WHEN a new check result is recorded, THE WebSocket_Service SHALL broadcast the result to all connected clients subscribed to that monitor within 2 seconds, including the monitor ID, status, response time in milliseconds, and timestamp.
3. WHEN a monitor status changes, THE WebSocket_Service SHALL broadcast a status change event within 2 seconds to all connected clients, including the monitor ID, previous status, new status, and timestamp of the transition.
4. THE WebSocket_Service SHALL support client subscription to specific monitors or to all monitors, and SHALL allow clients to update their subscriptions without disconnecting.
5. IF a WebSocket connection is lost, THEN THE WebSocket_Service SHALL support automatic client reconnection with exponential backoff starting at 1 second, doubling on each attempt, up to a maximum delay of 30 seconds, for a maximum of 10 reconnection attempts.
6. IF no pong response is received within 10 seconds of a ping frame, THEN THE WebSocket_Service SHALL close the unresponsive connection and release associated resources.

---

### Requirement 24: Uptime Heatmap Visualization

**User Story:** As a stakeholder, I want a calendar-style heatmap showing uptime history, so that I can quickly visualize availability patterns over time.

#### Acceptance Criteria

1. THE Heatmap_Renderer SHALL display a 90-day calendar grid where each cell represents one day and is color-coded by uptime percentage, with the most recent day on the right.
2. THE Heatmap_Renderer SHALL use the following color scale: green (99.5 percent or above), light green (95 to 99.4 percent), amber (80 to 94.9 percent), red (below 80 percent), and gray (no data).
3. WHEN a user hovers over or focuses (via keyboard) a heatmap cell, THE Heatmap_Renderer SHALL display a tooltip showing the date, uptime percentage, total checks, and number of failures for that day.
4. THE Heatmap_Renderer SHALL be accessible from the monitor detail view.
5. THE Heatmap_Renderer SHALL calculate uptime percentage per day using the monitor's configured timezone, defaulting to UTC if no timezone is configured.
6. IF a day has fewer than the expected number of checks (based on the monitor's check interval), THE Heatmap_Renderer SHALL still display the calculated uptime for the checks that were recorded.

---

### Requirement 25: Comparison View

**User Story:** As a performance analyst, I want to overlay multiple monitors on one chart, so that I can compare response times and identify correlations across services.

#### Acceptance Criteria

1. WHEN a user selects 2 or more monitors for comparison, THE Comparison_View SHALL render a single time-series chart plotting the average response time per check for each selected monitor as a distinct colored line.
2. THE Comparison_View SHALL support comparing a minimum of 2 and a maximum of 10 monitors simultaneously.
3. IF a user attempts to initiate a comparison with fewer than 2 monitors selected, THEN THE Comparison_View SHALL display an error message indicating that at least 2 monitors must be selected.
4. THE Comparison_View SHALL allow selection of time window (1 hour, 6 hours, 24 hours, 7 days) for the comparison, defaulting to 24 hours.
5. THE Comparison_View SHALL display a legend identifying each monitor line by name and color.
6. WHEN a monitor has no data within the selected time window, THE Comparison_View SHALL display that monitor in the legend with a "no data" label and omit its line from the chart.
7. THE Comparison_View SHALL use a shared Y-axis with an auto-scaled range that accommodates the minimum and maximum response time values across all displayed monitors.

---

### Requirement 26: SLA Calculator

**User Story:** As a service owner, I want to calculate actual uptime against SLA targets, so that I can track remaining error budget and report compliance to stakeholders.

#### Acceptance Criteria

1. THE SLA_Calculator SHALL compute actual uptime percentage for configurable calendar-aligned time periods (monthly, quarterly, yearly) using the formula: (total_monitored_time - total_downtime) / total_monitored_time * 100, rounded to 3 decimal places.
2. THE SLA_Calculator SHALL accept user-configured SLA targets per monitor as a percentage value between 90.0 and 99.999 (up to 3 decimal places).
3. THE SLA_Calculator SHALL display the remaining error budget as both a time duration (in hours and minutes) and a percentage of the total allowed downtime remaining.
4. WHEN the actual uptime drops below the configured SLA target, THE SLA_Calculator SHALL display a breach indicator next to the SLA metric and calculate the time overage beyond the allowed error budget.
5. THE SLA_Calculator SHALL display a reference table showing SLA levels 99 percent, 99.5 percent, 99.9 percent, 99.95 percent, and 99.99 percent with their equivalent allowed downtime per year, month, and week.
6. IF a selected time period contains no check data for the monitor, THEN THE SLA_Calculator SHALL display a no-data indicator instead of an uptime percentage and SHALL NOT report a breach.
7. IF the configured SLA target is outside the range of 90.0 to 99.999, THEN THE SLA_Calculator SHALL reject the input and display an error message indicating the acceptable range.

---

### Requirement 27: Custom Drag-and-Drop Dashboards

**User Story:** As a power user, I want to create personalized dashboard layouts with drag-and-drop widgets, so that I can focus on the metrics most relevant to my role.

#### Acceptance Criteria

1. THE Custom_Dashboard_Engine SHALL allow users to create up to 10 named dashboard layouts per user, where each dashboard name is between 1 and 64 characters, unique per user, and the layout persists across sessions.
2. THE Custom_Dashboard_Engine SHALL provide a widget library including: single monitor status, response time chart, uptime heatmap, Apdex score, SLA status, error rate chart, and comparison chart widgets, where each widget is configured with a target monitor or monitor set as its data source.
3. THE Custom_Dashboard_Engine SHALL support drag-and-drop repositioning and resizing of widgets within the dashboard grid, with a maximum of 20 widgets per dashboard.
4. THE Custom_Dashboard_Engine SHALL save dashboard layouts per user and restore them on login.
5. THE Custom_Dashboard_Engine SHALL support a minimum grid of 12 columns and allow widgets to span 1 to 12 columns and 1 to 4 rows.
6. WHEN a user has no custom dashboard configured, THE Custom_Dashboard_Engine SHALL display the default dashboard layout.
7. THE Custom_Dashboard_Engine SHALL allow users to delete dashboards and remove individual widgets from a dashboard.
8. IF a dashboard layout save fails, THEN THE Custom_Dashboard_Engine SHALL retain the unsaved layout state in the client and display an error message indicating the save failure.
9. IF a widget's configured data source monitor is deleted or unavailable, THEN THE Custom_Dashboard_Engine SHALL display the widget in an empty state with a message indicating the data source is unavailable.
