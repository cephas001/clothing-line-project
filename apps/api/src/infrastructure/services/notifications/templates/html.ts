// apps/api/src/infrastructure/services/notifications/templates/html.ts

// Minimal HTML primitives for the notification templates.
//
// Templates interpolate PRODUCER-NEUTRAL values only — never provider
// credentials, never raw provider envelopes, never internal infrastructure ids.
// Every user-controlled string (recipient name, item titles, notes) is
// HTML-escaped before interpolation so a malicious value can never inject
// markup into an email.

/** Escape a string for safe interpolation into HTML text/attribute content. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch] as string,
  );
}

/**
 * Wrap a plain-text-safe HTML body in the shared email shell. The shell is a
 * single, deliberately tiny layout — no branding assets, no external
 * dependencies, no tracking pixels.
 */
export function emailShell(htmlBody: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f6f6f6;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:24px 0;">',
    '<tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">',
    '<tr><td style="padding:24px 32px;border-bottom:1px solid #eeeeee;"><span style="font-size:16px;font-weight:bold;color:#111827;">Clothing Line</span></td></tr>',
    `<tr><td style="padding:24px 32px;font-size:14px;line-height:1.6;color:#374151;">${htmlBody}</td></tr>`,
    '<tr><td style="padding:16px 32px;border-top:1px solid #eeeeee;font-size:12px;color:#9ca3af;">This is an automated service message. No reply is monitored.</td></tr>',
    "</table></td></tr>",
    "</table></body></html>",
  ].join("\n");
}