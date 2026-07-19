# Design Document: Marketing Landing Page

## Overview

A self-contained marketing landing page for RxMonitor that serves as the new site root (`/`). Built with vanilla HTML and CSS (no frameworks), it showcases features, pricing, and trust signals while directing visitors to the dashboard (`/dashboard`) for sign-up and authentication. The landing page has its own styling completely independent of the dark-themed dashboard.

## Architecture

The marketing landing page is a self-contained static HTML/CSS page served by the existing Express server. It introduces a new route at `/` for the landing page and moves the existing dashboard to `/dashboard`. The implementation follows a zero-dependency approach — no JavaScript frameworks, no shared dashboard styles.

```
┌─────────────────────────────────────────────────────┐
│                  Express Server (server.js)          │
├─────────────────────────────────────────────────────┤
│  GET /            → public/landing.html             │
│  GET /dashboard   → public/index.html               │
│  GET /static/*    → express.static('public/')       │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              public/ directory                       │
├─────────────────────────────────────────────────────┤
│  landing.html   ← NEW (self-contained, links only   │
│  landing.css        landing.css)                     │
│  index.html     ← EXISTING (dashboard, unchanged)   │
│  style.css      ← EXISTING (dashboard styles)       │
│  app.js         ← EXISTING (dashboard JS)           │
└─────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. Express Server Route Changes (`server.js`)

The server needs two route additions placed **before** the `express.static` middleware:

```javascript
// Landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Dashboard route (serves existing index.html)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

These explicit routes take precedence over `express.static`, which would otherwise serve `index.html` at `/`. No authentication is required for either route — auth is handled client-side on the dashboard page.

The custom domain middleware (already in place) continues to override the root route for status page domains.

### 2. Landing Page HTML (`public/landing.html`)

A standalone HTML file with semantic structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RxMonitor - Free Uptime Monitoring</title>
  <meta name="description" content="...">
  <meta property="og:title" content="...">
  <meta property="og:description" content="...">
  <link rel="stylesheet" href="landing.css">
</head>
<body>
  <nav class="landing-nav">...</nav>
  <main>
    <section class="hero">...</section>
    <section class="features">...</section>
    <section class="trust">...</section>
    <section class="pricing">...</section>
    <section class="final-cta">...</section>
  </main>
  <footer class="landing-footer">...</footer>
</body>
</html>
```

No `<script>` tags for external frameworks. Minimal vanilla JS only if needed for mobile nav toggle.

### 3. Landing Page CSS (`public/landing.css`)

Self-contained stylesheet with no imports from `style.css`. Uses CSS custom properties for theming:

```css
:root {
  --landing-primary: #4f46e5;
  --landing-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  --landing-bg: #ffffff;
  --landing-text: #1f2937;
  --landing-muted: #6b7280;
  --landing-surface: #f9fafb;
  --landing-border: #e5e7eb;
  --landing-radius: 12px;
  --landing-max-width: 1200px;
}
```

Responsive breakpoints: 320px (mobile), 768px (tablet), 1024px (desktop), 1920px (wide).

## Page Sections Design

### Navigation Header
- Fixed/sticky positioning at viewport top
- Logo: 📡 RxMonitor
- Right side: "Sign In" link + "Get Started Free" button (both → `/dashboard`)
- Mobile: hamburger menu toggle (vanilla JS)

### Hero Section
- Large headline: core value proposition (e.g., "Know when your site goes down. Before your users do.")
- Subheadline: elaborates on monitoring capabilities
- "Always free for up to 5 monitors" prominent text
- "No credit card required" reassurance below CTA
- Primary CTA: "Get Started Free" → `/dashboard`
- Secondary CTA: "Sign In" → `/dashboard`
- Visual: light background with gradient accent shapes

### Feature Section
Seven capability cards in a responsive grid (3-column desktop, 2-column tablet, 1-column mobile):

| Feature | Icon | Description |
|---------|------|-------------|
| HTTP/HTTPS Monitoring | 🌐 | Monitor websites and APIs with configurable intervals |
| SSL Certificate Monitoring | 🔒 | Get alerted before certificates expire |
| Server Agent Metrics | 📊 | Track CPU, memory, and disk usage on your servers |
| Response Time Analytics | ⚡ | Percentile-based latency tracking and trends |
| Notifications | 🔔 | Instant alerts via Telegram and Email |
| Public Status Pages | 📋 | Share real-time uptime status with your users |
| Incident Management | ⚠️ | Track, escalate, and resolve downtime incidents |

### Trust/Social Proof Section
Three or more trust signals displayed as stat counters:
- "99.9% Uptime Guarantee" 
- "Checks every 60 seconds"
- "Used by developers worldwide"

Visually distinct: uses a subtle background color or gradient strip to separate from adjacent sections.

### Pricing Section
Two cards side-by-side (stacked on mobile):

**Free Tier Card:**
- Label: "Always Free" / "Free Forever"
- Price: ₹0 / Free
- Features: Up to 5 monitors, 60s check interval, Telegram & Email alerts, Public status page
- CTA: "Start Free" → `/dashboard`
- "No credit card required" note

**Premium Tier Card:**
- Label: "Premium"
- Price: ₹499/month
- Features: Unlimited monitors, 10s check interval, Server agents, Priority support, Advanced analytics
- CTA: "Upgrade" → `/dashboard`
- Visually highlighted (border/gradient accent)

### Final CTA Block
- Bold headline: "Start monitoring in 30 seconds. Always free."
- Reassurance: "No credit card required. No time limit on free plan."
- Primary CTA: "Get Started Free" → `/dashboard`
- Gradient or contrasting background for visual emphasis

### Footer
- 📡 RxMonitor branding
- Copyright: © 2025 RxMonitor
- Links: Dashboard, Status Page, etc.

## Data Models

No new data models or database changes are required. The landing page is purely static content.

## Interfaces

### Server Route Interface

| Route | Method | Response | Auth Required |
|-------|--------|----------|---------------|
| `/` | GET | `landing.html` (200) | No |
| `/dashboard` | GET | `index.html` (200) | No |

### CTA Navigation Interface

All CTA buttons use standard anchor tags (`<a>`) with `href="/dashboard"`. No JavaScript navigation required.

## Error Handling

- **404 for landing assets**: Express static middleware handles this automatically for `landing.css`
- **Custom domain override**: The existing custom domain middleware takes precedence over the root route. When a custom domain matches, the status page is served at `/` instead of the landing page (existing behavior preserved)
- **Mobile nav**: The hamburger menu uses vanilla JS with graceful fallback — if JS fails, nav links are still visible in the DOM

## Performance Considerations

- No external JS frameworks → minimal payload
- Single CSS file (`landing.css`) → one stylesheet request
- No render-blocking scripts
- Google Fonts can be preconnected if used (optional)
- Images: use emoji for icons (zero network requests) or inline SVG
- CSS gradients instead of image backgrounds

## Accessibility

- Semantic HTML5 elements: `<nav>`, `<main>`, `<section>`, `<footer>`, `<header>`
- All interactive elements get `aria-label` attributes
- All images get non-empty `alt` attributes
- Sufficient color contrast on text (minimum 4.5:1 ratio)
- Keyboard navigable: all CTAs are `<a>` elements (natively focusable)
- Skip-to-content link for screen readers

## Testing Strategy

- **Unit tests (example-based)**: Verify HTML structure — correct sections exist in order, required content is present (feature cards, pricing tiers, meta tags, semantic elements), and routing returns correct files.
- **Property tests**: Validate CTA link consistency (all action buttons point to `/dashboard`) and accessibility completeness (all images have alt text, all interactive elements have accessible names) across the entire DOM.
- **Integration tests**: Verify Express routing serves landing.html at `/` and index.html at `/dashboard`, and existing static file paths remain functional.
- **Smoke tests**: Confirm file structure (`landing.html` exists, references only `landing.css`, no JS framework imports).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: CTA Link Consistency

*For all* anchor elements and button-links on the landing page that serve as call-to-action buttons (containing text "Get Started Free", "Start Free", "Sign In", or "Upgrade"), the `href` attribute SHALL point to `/dashboard`.

**Validates: Requirements 7.1, 7.2, 5.6, 5.7, 11.3**

### Property 2: Accessibility Completeness

*For all* `<img>` elements in the landing page, the `alt` attribute SHALL be present and non-empty; and *for all* interactive elements (`<a>`, `<button>`) the element SHALL have either meaningful text content or a non-empty `aria-label` attribute providing an accessible name.

**Validates: Requirements 9.3**
