# Design Document

## Overview

This feature ensures that email verification links are delivered to users' real inboxes via SMTP during signup, while maintaining a graceful fallback for development environments. It introduces a configuration priority hierarchy (env vars over admin panel), gates monitor creation behind email verification, and allows unverified users to explore the dashboard.

## Architecture

This feature refactors the email verification delivery flow by introducing a dedicated SMTP configuration resolver module (`smtp-config.js`) that merges environment variables with admin panel settings following a defined priority hierarchy. The existing inline email-sending logic in the signup endpoint is replaced with calls to this resolver, keeping the transporter creation pattern consistent with `notifier.js`.

The monitor creation endpoint gains a verification gate that checks `is_verified` on the authenticated user before allowing resource creation. The login endpoint is relaxed to allow unverified users to authenticate (returning `is_verified` in the JWT payload), enabling dashboard exploration before verification.

## Components and Interfaces

### 1. SMTP Configuration Resolver (`smtp-config.js`)

A pure function module responsible for resolving SMTP configuration from two sources:

- **Environment variables**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- **Admin panel settings**: `email_smtp_host`, `email_smtp_port`, `email_smtp_user`, `email_smtp_pass`, `email_sender` from the `settings` table

The resolver returns a unified config object or `null` if SMTP is unconfigured (no host from either source).

### 2. Verification Email Sender (within `server.js` signup handler)

Consumes the resolved SMTP config to construct a Nodemailer transporter and send verification emails. Falls back gracefully when config is `null` or the transporter throws.

### 3. Monitor Creation Verification Gate (within `server.js` POST /api/monitors)

A check added to the authenticated branch of the monitor creation endpoint that rejects requests from unverified users with HTTP 403.

### 4. Login Endpoint Modification (within `server.js` POST /api/auth/login)

Removes the existing block on unverified users, allowing them to authenticate. Adds `is_verified` to the JWT payload.

### Interfaces

### `resolveSmtpConfig(envVars, adminSettings) → SmtpConfig | null`

```javascript
/**
 * Resolves SMTP configuration by merging environment variables (priority)
 * with admin panel settings (fallback).
 *
 * @param {object} envVars - Environment variables object (e.g., process.env)
 * @param {object} adminSettings - Key/value map from the settings table
 * @returns {object|null} Resolved SMTP config or null if unconfigured
 */
export function resolveSmtpConfig(envVars, adminSettings) {
  const host = envVars.SMTP_HOST || adminSettings.email_smtp_host || null;
  if (!host) return null;

  return {
    host,
    port: parseInt(envVars.SMTP_PORT || adminSettings.email_smtp_port) || 587,
    user: envVars.SMTP_USER || adminSettings.email_smtp_user || '',
    pass: envVars.SMTP_PASS || adminSettings.email_smtp_pass || '',
    from: envVars.SMTP_FROM || adminSettings.email_sender || '"RxMonitor" <noreply@rxmonitor.local>',
  };
}
```

### `buildVerificationEmail(toEmail, verificationLink) → EmailPayload`

```javascript
/**
 * Constructs the verification email payload with both text and HTML bodies.
 *
 * @param {string} toEmail - Recipient email address
 * @param {string} verificationLink - Full verification URL
 * @param {string} fromAddress - Sender address
 * @returns {object} Nodemailer-compatible mail options
 */
export function buildVerificationEmail(toEmail, verificationLink, fromAddress) {
  return {
    from: fromAddress,
    to: toEmail,
    subject: '[RxMonitor] Verify your email address',
    text: `Please verify your email by clicking the following link: ${verificationLink}`,
    html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px;">
            <h2>Welcome to RxMonitor!</h2>
            <p>Please click the button below to verify your email address:</p>
            <a href="${verificationLink}" style="display: inline-block; background: #6366f1; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 15px 0;">Verify Email Address</a>
            <p style="font-size: 0.8em; color: #64748b;">Or copy and paste this link in your browser:<br>${verificationLink}</p>
           </div>`,
  };
}
```

### `formatVerificationLog(email, verificationLink) → string`

```javascript
/**
 * Formats the console log message for verification link output.
 *
 * @param {string} email - User's email address
 * @param {string} verificationLink - Full verification URL
 * @returns {string} Formatted log message
 */
export function formatVerificationLog(email, verificationLink) {
  return `\n✉️ [Email Verification Link for ${email}]: ${verificationLink}\n`;
}
```

## Data Models

### SmtpConfig Object

```javascript
{
  host: string,    // SMTP server hostname
  port: number,    // SMTP port (default: 587)
  user: string,    // SMTP auth username
  pass: string,    // SMTP auth password
  from: string     // Sender address (default: '"RxMonitor" <noreply@rxmonitor.local>')
}
```

### JWT Payload (updated)

```javascript
{
  id: number,
  email: string,
  role: string,
  is_verified: boolean  // NEW: indicates email verification status
}
```

### Environment Variables (added to .env.example)

```
# SMTP Configuration (optional — overrides admin panel settings)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

## Sequence Flow

### Signup with Email Delivery

1. User POSTs to `/api/auth/signup` with email and password
2. Server creates user record with `is_verified=0` and a `verification_token`
3. Server constructs `verificationLink` from `BASE_URL + token`
4. Server calls `formatVerificationLog()` and logs to console (always)
5. Server loads admin settings from DB, calls `resolveSmtpConfig(process.env, adminSettings)`
6. If config is `null` → signup completes, response returned (fallback: link already logged)
7. If config exists → build transporter, call `buildVerificationEmail()`, attempt `sendMail()`
8. If send succeeds → log confirmation
9. If send fails → log error, signup still completes successfully

### Monitor Creation with Verification Gate

1. User POSTs to `/api/monitors` with auth token
2. `authenticateToken` middleware decodes JWT
3. If `req.user` exists and `req.user.is_verified === false`:
   - Return 403 with `{ error: 'Email verification is required to create monitors.' }`
4. Otherwise proceed with existing monitor creation logic

### Login with Unverified Access

1. User POSTs to `/api/auth/login` with credentials
2. Server validates credentials
3. Server signs JWT including `is_verified: !!user.is_verified`
4. Server returns token and user object (including `is_verified`)
5. Unverified users can access read-only endpoints normally

## Error Handling

| Scenario | Behavior |
|----------|----------|
| SMTP not configured (no host) | Signup succeeds, link logged to console only |
| Transporter creation fails | Error logged, signup succeeds, link in console |
| `sendMail()` rejects | Error logged, signup succeeds, link in console |
| Invalid SMTP port in env | Falls back to 587 (parseInt returns NaN → `|| 587`) |
| Unverified user creates monitor | HTTP 403, descriptive error message |
| Unverified user logs in | Success — JWT issued with `is_verified: false` |

## Testing Strategy

- **Property-based tests** (fast-check + vitest): Validate the SMTP config resolver, email payload builder, console log formatter, and verification gate logic with randomized inputs. Minimum 100 iterations per property.
- **Unit tests** (vitest): Verify specific examples like default port/sender values, the exact 403 error message text, and the confirmation log after successful send.
- **Integration tests**: Test the full signup flow with a mocked Nodemailer transporter, verifying end-to-end behavior for configured/unconfigured/failing SMTP scenarios.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: SMTP config resolution priority

*For any* combination of environment variables and admin panel settings where both define the same SMTP field, the resolved configuration SHALL use the environment variable value for that field. *For any* field absent from environment variables but present in admin settings, the resolved configuration SHALL use the admin setting value.

**Validates: Requirements 1.1, 1.2, 2.1, 2.2**

### Property 2: SMTP unconfigured detection

*For any* environment and admin settings combination where neither provides a non-empty SMTP_HOST value, the SMTP configuration resolver SHALL return null (indicating SMTP is unconfigured).

**Validates: Requirements 2.3**

### Property 3: Verification email contains link in both bodies

*For any* valid email address and verification link string, the constructed email payload SHALL contain the verification link in both the plain-text body and the HTML body, and the subject SHALL contain "Verify your email".

**Validates: Requirements 3.2, 3.3, 3.4**

### Property 4: Signup resilience to SMTP failures

*For any* valid signup request, whether SMTP is unconfigured or the transporter throws an error, the signup operation SHALL complete successfully (user record created, 200 response returned) and the verification link SHALL be logged to the console.

**Validates: Requirements 4.1, 4.2, 4.3, 7.1**

### Property 5: Verification status gates monitor creation

*For any* authenticated user, the monitor creation endpoint SHALL return HTTP 403 if and only if the user's `is_verified` status is false. Verified users SHALL be permitted to create monitors (subject to other constraints like tier limits).

**Validates: Requirements 5.1, 5.2, 5.3**

### Property 6: Unverified user authentication and JWT payload

*For any* unverified user with valid credentials, the login endpoint SHALL return a valid JWT token, and that token's payload (or the user profile response) SHALL include the `is_verified` field reflecting the user's actual verification status.

**Validates: Requirements 6.1, 6.3**

### Property 7: Console log format includes email and link

*For any* user email address and verification token, the formatted console log message SHALL contain both the user's email address and the full verification link URL.

**Validates: Requirements 7.1, 7.2**
