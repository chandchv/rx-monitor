# Implementation Plan: Marketing Landing Page

## Overview

Build a self-contained marketing landing page for RxMonitor served at the root URL (`/`). The implementation adds two Express routes, a new `landing.html`, and a dedicated `landing.css` — all without modifying existing dashboard code or adding dependencies.

## Tasks

- [x] 1. Set up Express server routes
  - [x] 1.1 Add landing page and dashboard routes to server.js
    - Add `GET /` route that serves `public/landing.html` via `res.sendFile`
    - Add `GET /dashboard` route that serves `public/index.html` via `res.sendFile`
    - Place both routes **before** the `express.static` middleware so they take precedence
    - Ensure custom domain middleware still overrides root for status page domains
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 2. Create landing page HTML structure
  - [x] 2.1 Create public/landing.html with full semantic page structure
    - Create `public/landing.html` with `<!DOCTYPE html>`, `<html lang="en">`, proper `<head>` with meta charset, viewport, SEO meta tags (title, description, Open Graph), and a single `<link rel="stylesheet" href="landing.css">`
    - Build the `<body>` with semantic elements in this order: `<nav class="landing-nav">` (sticky header with 📡 RxMonitor logo, "Sign In" link, "Get Started Free" button), `<main>` containing `<section class="hero">`, `<section class="features">`, `<section class="trust">`, `<section class="pricing">`, `<section class="final-cta">`, then `<footer class="landing-footer">`
    - Hero section: primary headline (uptime monitoring value prop), subheadline, "Always free for up to 5 monitors" text, "No credit card required" reassurance, primary CTA "Get Started Free" → `/dashboard`, secondary CTA "Sign In" → `/dashboard`
    - Features section: 7 cards (HTTP/HTTPS Monitoring 🌐, SSL Certificate Monitoring 🔒, Server Agent Metrics 📊, Response Time Analytics ⚡, Notifications 🔔, Public Status Pages 📋, Incident Management ⚠️) each with icon, name, and 1-2 sentence description
    - Trust section: at least 3 trust signals (e.g., "99.9% Uptime Guarantee", "Checks every 60 seconds", "Used by developers worldwide") with visually distinct background
    - Pricing section: two cards — Free Forever (₹0, up to 5 monitors, 60s interval, Telegram & Email alerts, status page, CTA "Start Free" → `/dashboard`, "No credit card required" note) and Premium (₹499/month, unlimited monitors, 10s interval, server agents, priority support, advanced analytics, CTA "Upgrade" → `/dashboard`, highlighted with accent border)
    - Final CTA block: bold headline "Start monitoring in 30 seconds. Always free.", reassurance "No credit card required. No time limit on free plan.", primary CTA "Get Started Free" → `/dashboard`, gradient/contrasting background
    - Footer: 📡 RxMonitor, © 2025 RxMonitor, links (Dashboard, Status Page)
    - All CTAs use `<a href="/dashboard">` elements; add `aria-label` attributes on interactive elements
    - No external JS frameworks; optional minimal vanilla JS for mobile nav hamburger toggle
    - _Requirements: 1.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 7.1, 7.2, 7.3, 8.2, 8.3, 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 11.1, 11.2, 11.3, 11.4_

- [x] 3. Create landing page CSS
  - [x] 3.1 Create public/landing.css with complete responsive styling
    - Define CSS custom properties (`:root` block): `--landing-primary`, `--landing-gradient`, `--landing-bg`, `--landing-text`, `--landing-muted`, `--landing-surface`, `--landing-border`, `--landing-radius`, `--landing-max-width`
    - Style sticky navigation: fixed top, white background, logo + nav items layout, mobile hamburger toggle
    - Style hero section: large headline typography, gradient accent shapes, CTA button styles (primary filled, secondary outline)
    - Style features grid: 3-col desktop, 2-col tablet, 1-col mobile; card styles with border-radius, subtle shadow
    - Style trust section: distinct background strip, stat counter layout
    - Style pricing cards: side-by-side desktop, stacked mobile; free vs premium differentiation with accent border on premium
    - Style final CTA: gradient background, centered content, prominent button
    - Style footer: branding, links, copyright
    - Responsive breakpoints: 320px, 768px, 1024px, 1920px
    - No imports from `style.css`; fully self-contained
    - _Requirements: 1.2, 1.3, 3.5, 8.1, 8.4_

- [x] 4. Checkpoint - Verify routing and file structure
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Write tests for routing and landing page
  - [x] 5.1 Write integration tests for Express route changes
    - Create `tests/marketing-landing-page/routes.test.js`
    - Test `GET /` returns 200 with HTML content containing "landing" identifiers
    - Test `GET /dashboard` returns 200 with HTML content from index.html
    - Test existing static file paths (e.g., `/style.css`, `/app.js`) still serve correctly
    - Use vitest with supertest or direct Express app testing
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 5.2 Write property test for CTA link consistency
    - **Property 1: CTA Link Consistency**
    - Create `tests/marketing-landing-page/landing-page.property.test.js`
    - Use fast-check and jsdom to parse `landing.html`
    - Assert that all anchor elements containing CTA text ("Get Started Free", "Start Free", "Sign In", "Upgrade") have `href="/dashboard"`
    - **Validates: Requirements 7.1, 7.2, 5.6, 5.7, 11.3**

  - [ ]* 5.3 Write property test for accessibility completeness
    - **Property 2: Accessibility Completeness**
    - In the same or adjacent test file, use jsdom to parse `landing.html`
    - Assert all `<img>` elements have a non-empty `alt` attribute
    - Assert all `<a>` and `<button>` elements have either meaningful text content or a non-empty `aria-label`
    - **Validates: Requirements 9.3**

  - [ ]* 5.4 Write unit tests for landing page structure
    - Test page contains all required sections in correct order (nav, hero, features, trust, pricing, final-cta, footer)
    - Test 7 feature cards are present
    - Test both pricing tiers exist with correct labels
    - Test meta tags (title, description, og:title, og:description) are present
    - Test no references to `style.css` in landing.html
    - _Requirements: 1.2, 4.1, 5.1, 5.2, 9.4, 10.1_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The landing page is purely static (no database changes, no new dependencies)
- All CTA navigation uses standard `<a href="/dashboard">` — no JavaScript routing needed

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["5.1", "5.2", "5.3", "5.4"] }
  ]
}
```
