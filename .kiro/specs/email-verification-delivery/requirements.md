# Requirements Document

## Introduction

This feature upgrades the email verification flow in RxMonitor so that signup verification links are delivered to users' real email inboxes via SMTP, rather than only being logged to the server console. SMTP configuration supports both environment variables and admin panel settings with a defined priority hierarchy. A graceful fallback ensures signup is never blocked when SMTP is unavailable, and unverified users are restricted from creating monitors until they complete email verification.

## Glossary

- **Email_Delivery_Service**: The server-side module responsible for constructing a Nodemailer transporter and sending verification emails to users.
- **SMTP_Configuration**: The set of credentials and host details (host, port, user, password, sender address) required to connect to an outbound SMTP relay.
- **Env_SMTP_Config**: SMTP settings sourced from environment variables (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) loaded via the .env file.
- **Admin_Panel_SMTP_Config**: SMTP settings stored in the SQLite settings table, configurable through the RxMonitor admin panel UI.
- **Verification_Email**: An email message containing a unique verification link sent to a user's inbox upon signup.
- **Verification_Link**: A URL containing a unique token that, when visited, marks the user's account as verified.
- **Unverified_User**: A user account whose is_verified field is 0 (email not yet confirmed).
- **Monitor_Creation_Endpoint**: The API route that creates new uptime monitors (POST /api/monitors).

## Requirements

### Requirement 1: Environment Variable SMTP Configuration

**User Story:** As a system administrator, I want to configure SMTP credentials via environment variables, so that email delivery works immediately on deployment without requiring admin panel setup.

#### Acceptance Criteria

1. THE Email_Delivery_Service SHALL read SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM from environment variables at startup.
2. WHEN SMTP_HOST is defined in the environment, THE Email_Delivery_Service SHALL use the Env_SMTP_Config to construct the Nodemailer transporter.
3. WHEN SMTP_PORT is not defined in the environment, THE Email_Delivery_Service SHALL default SMTP_PORT to 587.
4. WHEN SMTP_FROM is not defined in the environment, THE Email_Delivery_Service SHALL default the sender address to "RxMonitor <noreply@rxmonitor.local>".

### Requirement 2: SMTP Configuration Priority

**User Story:** As a system administrator, I want environment variables to take priority over admin panel SMTP settings, so that deployment configuration is predictable and the admin panel serves as a fallback override.

#### Acceptance Criteria

1. WHEN both Env_SMTP_Config and Admin_Panel_SMTP_Config are available, THE Email_Delivery_Service SHALL use Env_SMTP_Config values for any field defined in the environment.
2. WHEN a specific SMTP field is absent from environment variables but present in Admin_Panel_SMTP_Config, THE Email_Delivery_Service SHALL use the Admin_Panel_SMTP_Config value for that field.
3. WHEN neither Env_SMTP_Config nor Admin_Panel_SMTP_Config provides SMTP_HOST, THE Email_Delivery_Service SHALL treat SMTP as unconfigured.

### Requirement 3: Verification Email Delivery

**User Story:** As a new user, I want to receive a verification email in my inbox after signing up, so that I can verify my account without needing server console access.

#### Acceptance Criteria

1. WHEN a user signs up and SMTP_Configuration is available, THE Email_Delivery_Service SHALL send a Verification_Email to the user's registered email address.
2. THE Verification_Email SHALL contain the Verification_Link as a clickable URL.
3. THE Verification_Email SHALL include a subject line containing "Verify your email".
4. THE Verification_Email SHALL include both a plain-text body and an HTML body containing the Verification_Link.
5. WHEN the Verification_Email is sent successfully, THE Email_Delivery_Service SHALL log a confirmation message to the server console.

### Requirement 4: Graceful Fallback When SMTP Is Unavailable

**User Story:** As a developer setting up RxMonitor locally, I want signup to succeed even when SMTP is not configured, so that I can develop and test without an email server.

#### Acceptance Criteria

1. WHEN a user signs up and SMTP_Configuration is unavailable, THE Email_Delivery_Service SHALL allow the signup to complete without error.
2. WHEN SMTP_Configuration is unavailable, THE Email_Delivery_Service SHALL log the Verification_Link to the server console as a development fallback.
3. IF the Verification_Email fails to send due to a transporter error, THEN THE Email_Delivery_Service SHALL log the error, allow signup to complete, and log the Verification_Link to the server console.

### Requirement 5: Unverified User Monitor Restriction

**User Story:** As a product owner, I want unverified users to be unable to create monitors, so that only legitimate verified accounts consume monitoring resources.

#### Acceptance Criteria

1. WHILE a user is an Unverified_User, THE Monitor_Creation_Endpoint SHALL reject monitor creation requests with HTTP status 403.
2. WHILE a user is an Unverified_User, THE Monitor_Creation_Endpoint SHALL return an error message indicating that email verification is required.
3. WHEN a user is verified, THE Monitor_Creation_Endpoint SHALL allow monitor creation requests from that user.

### Requirement 6: Unverified User Dashboard Access

**User Story:** As a new user who has not yet verified, I want to log in and browse the dashboard, so that I can explore the platform before completing verification.

#### Acceptance Criteria

1. THE Email_Delivery_Service SHALL allow Unverified_User accounts to authenticate and receive a valid JWT token.
2. WHILE a user is an Unverified_User, THE Email_Delivery_Service SHALL allow access to all read-only dashboard endpoints.
3. THE Email_Delivery_Service SHALL include the is_verified status in the JWT payload or user profile response.

### Requirement 7: Verification Link Console Logging

**User Story:** As a developer, I want the verification link always logged to the console regardless of email delivery status, so that I have a reliable fallback during development.

#### Acceptance Criteria

1. WHEN a user signs up, THE Email_Delivery_Service SHALL log the Verification_Link to the server console regardless of whether SMTP_Configuration is available.
2. THE Email_Delivery_Service SHALL format the console log message to include the user's email address and the full Verification_Link URL.
