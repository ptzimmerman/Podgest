# UI Agent Context

## Purpose

Verify and test the Podgest web application UI using browser automation. Use this agent to check visual appearance, test interactions, and validate UI changes.

## Web Application URLs

- **Production**: `https://podgest-web.pages.dev`
- **Settings Page**: `https://podgest-web.pages.dev/settings`
- **Subscriptions Page**: `https://podgest-web.pages.dev/subscriptions`

## Browser MCP Tools

Use the `cursor-ide-browser` MCP server for browser automation:

### Navigation & Screenshots
1. `browser_navigate` - Navigate to a URL
2. `browser_snapshot` - Get page structure and element refs (ALWAYS do this before interacting)
3. `browser_tabs` - List/manage open tabs

### Interactions
1. `browser_click` - Click an element by ref
2. `browser_type` - Type text (appends)
3. `browser_fill` - Fill/replace text in input
4. `browser_hover` - Hover over element
5. `browser_scroll` - Scroll the page

### Lock/Unlock Workflow
**CRITICAL**: Follow this order:
1. `browser_navigate` first (creates tab)
2. `browser_lock` (locks for interaction)
3. Perform interactions
4. `browser_unlock` when done

## Common Verification Tasks

### Check Dark Mode
1. Navigate to settings page
2. Find and click the dark mode toggle (sun/moon icon in header)
3. Take snapshot to verify dark backgrounds on cards
4. Toggle back to light mode and verify

### Check Page Elements
1. Navigate to target page
2. Take snapshot
3. Verify key elements are present (headers, cards, buttons)
4. Check colors and styling

### Test Login Flow
1. Navigate to production URL
2. Should redirect to login if not authenticated
3. Google OAuth button should be visible

## Test User Credentials

For testing authenticated features, use:
- Email: `pete@fianu.io`
- Sign in via Google OAuth

## Reporting

When verifying UI:
1. Report what you see (page structure, colors, layout)
2. Note any issues (broken styling, missing elements, accessibility problems)
3. Compare against expected behavior
4. Take snapshots at key points
