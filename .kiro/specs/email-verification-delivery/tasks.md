# Implementation Plan: Email Verification Delivery

## Overview

Implement SMTP-based email verification delivery by creating a dedicated `smtp-config.js` module with pure functions for configuration resolution, email building, and log formatting. Modify the existing signup, login, and monitor creation endpoints in `server.js` to integrate with this module. Add property-based tests and unit tests using vitest and fast-check.

## Tasks

- [x] 1. Create SMTP configuration module
  - [x] 1.1 Create `smtp-config.js` with `resolveSmtpConfig`, `buildVerificationEmail`, and `formatVerificationLog` exports
    - Implement `resolveSmtpConfig(envVars, adminSettings)` that merges env vars (priority) with admin settings (fallback), returning config object or `null` when no host is available
    - Implement `buildVerificationEmail(toEmail, verificationLink, fromAddress)` returning a Nodemailer-compatible mail options object with subject, text, and HTML bodies
    - Implement `formatVerificationLog(email, verificationLink)` returning a formatted console string containing both email and link
    - Default port to 587 when not specified or invalid, default from address to `"RxMonitor" <noreply@rxmonitor.local>`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.2, 3.3, 3.4, 7.2_

  - [ ]* 1.2 Write property tests for `resolveSmtpConfig`
    - **Property 1: SMTP config resolution priority**
    - **Property 2: SMTP unconfigured detection**
    - Use fast-check to generate arbitrary env/admin settings objects and verify env vars always take precedence, null returned when no host present
    - **Validates: Requirements 1.1, 1.2, 2.1, 2.2, 2.3**

  - [ ]* 1.3 Write property tests for `buildVerificationEmail` and `formatVerificationLog`
    - **Property 3: Verification email contains link in both bodies**
    - **Property 7: Console log format includes email and link**
    - Use fast-check to generate arbitrary email addresses and URLs, verify link appears in both text and HTML body, subject contains "Verify your email", log output contains email and link
    - **Validates: Requirements 3.2, 3.3, 3.4, 7.1, 7.2**

- [x] 2. Update signup endpoint to use SMTP delivery
  - [x] 2.1 Modify POST `/api/auth/signup` in `server.js` to integrate `smtp-config.js`
    - Import `resolveSmtpConfig`, `buildVerificationEmail`, `formatVerificationLog` from `smtp-config.js`
    - After user creation, always call `formatVerificationLog()` and `console.log()` the result
    - Load admin settings from DB, call `resolveSmtpConfig(process.env, adminSettings)`
    - If config is not null, create Nodemailer transporter, call `buildVerificationEmail()`, attempt `sendMail()`
    - On send success, log confirmation message
    - On send failure or config null, allow signup to complete without error
    - _Requirements: 3.1, 3.5, 4.1, 4.2, 4.3, 7.1_

  - [ ]* 2.2 Write unit tests for signup SMTP integration
    - Test signup completes when SMTP is unconfigured (no host)
    - Test signup completes when transporter throws an error
    - Test confirmation log emitted on successful send
    - Mock Nodemailer transporter for isolation
    - **Validates: Requirements 3.1, 3.5, 4.1, 4.2, 4.3**

- [x] 3. Checkpoint - Verify SMTP module and signup integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Modify login endpoint and add verification gate
  - [x] 4.1 Modify POST `/api/auth/login` in `server.js` to allow unverified users
    - Remove any existing block that prevents unverified users from logging in
    - Add `is_verified: !!user.is_verified` to the JWT payload
    - Include `is_verified` in the user profile returned in the login response
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 4.2 Add verification gate to POST `/api/monitors` in `server.js`
    - After `authenticateToken` middleware, check `req.user.is_verified`
    - If `is_verified` is false/falsy, return HTTP 403 with `{ error: 'Email verification is required to create monitors.' }`
    - Verified users proceed through existing monitor creation logic
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 4.3 Write property test for verification gate
    - **Property 5: Verification status gates monitor creation**
    - Use fast-check to generate arbitrary boolean verification statuses, verify 403 returned if and only if `is_verified` is false
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [ ]* 4.4 Write property test for login JWT payload
    - **Property 6: Unverified user authentication and JWT payload**
    - Use fast-check to generate arbitrary user objects with varying `is_verified` states, verify JWT always includes `is_verified` field matching user state
    - **Validates: Requirements 6.1, 6.3**

- [x] 5. Add SMTP environment variable documentation
  - [x] 5.1 Update `.env.example` with SMTP configuration variables
    - Add `SMTP_HOST=`, `SMTP_PORT=587`, `SMTP_USER=`, `SMTP_PASS=`, `SMTP_FROM=` with descriptive comments
    - _Requirements: 1.1_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The `smtp-config.js` module uses pure functions for easy testability
- Console log of verification link is always present regardless of SMTP status (Requirement 7.1)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "5.1"] },
    { "id": 2, "tasks": ["2.2", "4.1", "4.2"] },
    { "id": 3, "tasks": ["4.3", "4.4"] }
  ]
}
```
