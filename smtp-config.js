/**
 * SMTP Configuration Resolver
 * 
 * Pure function module responsible for resolving SMTP configuration,
 * building verification email payloads, and formatting console log messages.
 */

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
