# Firefox Port for Zoom Web Browser Bot

## Overview

This branch ports the Zoom web browser bot from Chromium/CloakBrowser to Firefox to test whether Zoom's ISP-based bot detection also blocks Firefox browsers.

## Automation Verification

**All Zoom automation is browser-agnostic and works identically in Firefox:**

✅ **Selectors**: CSS selectors, aria-label, text matching - all browser-agnostic
✅ **Click automation**: `page.locator().click({ force: true })` - works in both browsers
  - Chromium: Uses CDP, routes through CloakBrowser humanization
  - Firefox: Uses WebDriver BiDi, trusted clicks but no humanization layer
✅ **Keyboard input**: `page.keyboard.type()` - browser-agnostic Playwright API
✅ **Media permissions**:
  - Chromium: `grantPermissions()` call
  - Firefox: `firefoxUserPrefs` for permissions (grantPermissions wrapped in try/catch)
✅ **Page evaluation**: `page.evaluate()` - works identically
✅ **Waiting/timeouts**: `waitForSelector`, `waitForFunction` - browser-agnostic

**Key difference:** Firefox clicks are trusted (isTrusted=true) but lack CloakBrowser's anti-fingerprinting humanization (randomized mouse movement, timing). This is actually the test goal - does Firefox's different fingerprint bypass ISP blocking?

## Changes Made

### 1. Browser Layer (`src/browser/browser.ts`)

**Added Firefox support:**
- New `openFirefoxBrowser()` function that launches Firefox via Playwright
- Conditional logic in `openBrowser()` to choose Firefox or CloakBrowser based on `USE_FIREFOX` env var
- Firefox-specific configuration including:
  - Firefox preferences (firefoxUserPrefs) for media permissions, WebRTC, autoplay
  - Firefox command-line args
  - WebGL enabled (important for Zoom fingerprinting)
  - Privacy/tracking protection disabled (to avoid interference)
  - Locale/timezone alignment with proxy exit IP (same as Chromium version)

**Key differences from Chromium:**
- Uses `firefox.launchPersistentContext()` instead of CloakBrowser
- Firefox preferences (`firefoxUserPrefs`) instead of Chrome command-line flags
- No CloakBrowser humanization layer (no anti-fingerprinting spoofing)
- WebGL force-enabled to avoid null context (bot tell)

### 2. Environment Configuration (`src/config/env-vars.ts`)

**Added:**
- `USE_FIREFOX` boolean environment variable (default: `false`)
- Documentation explaining it's for testing ISP blocking on Firefox

### 3. Environment Example (`.env.example`)

**Added:**
- `USE_FIREFOX=false` with documentation
- Explanation that this is for testing Zoom ISP blocking on Firefox browsers

## Testing Instructions

### Prerequisites

1. Install Firefox browser for Playwright:
```bash
cd apps/meet-teams-bot
npx playwright install firefox
```

2. Ensure all existing dependencies are installed:
```bash
npm install
```

### Local Testing

1. Build the code:
```bash
npm run build
```

2. Create a test `.env` file with Firefox enabled:
```bash
USE_FIREFOX=true
# ... other required env vars from .env.example
```

3. Run the bot with a Zoom meeting link:
```bash
# Using the run_bot.sh script or direct invocation
./run_bot.sh
```

### Pre-Production Testing

Based on the original branch history (`feat/zoom-browser-recording-v2`), the pre-production deployment process likely involved:

1. Push the branch to remote
2. Deploy to pre-prod environment
3. Trigger a test Zoom meeting recording with `USE_FIREFOX=true`
4. Monitor for:
   - Whether Firefox successfully joins Zoom meetings
   - Whether ISP blocking occurs (same "ZoomRequiresRtms" error)
   - Browser fingerprinting differences
   - Audio/video capture quality

## Expected Behavior

### When `USE_FIREFOX=false` (default)
- Bot uses CloakBrowser/Chromium (existing behavior)
- Anti-fingerprinting via CloakBrowser active
- Tested against ISP blocking with residential proxy + retry logic

### When `USE_FIREFOX=true`
- Bot uses Firefox via Playwright
- **No** CloakBrowser anti-fingerprinting (tests raw Firefox)
- Same Zoom automation flow (selectors, join logic, etc.)
- Same proxy configuration applied
- Same ISP/residential proxy support

## Known Limitations & Considerations

1. **No CloakBrowser humanization**: Firefox mode doesn't have the anti-bot humanization layer (randomized viewport, mouse movement, etc.). This is intentional to test if Firefox's different fingerprint bypasses Zoom's detection.

2. **WebGL fingerprinting**: Firefox WebGL renderer will differ from spoofed Chromium/CloakBrowser. This could be a positive (different fingerprint) or negative (more easily identified as bot).

3. **Audio/Video capture**: PulseAudio virtual devices should work the same, but Firefox's WebRTC implementation differs from Chromium. Monitor for audio capture issues.

4. **Dockerfile changes needed**: The production Dockerfile may need Firefox installation steps. Currently only installs Chrome/Chromium.

## Next Steps

1. **Test in pre-prod** with a Zoom meeting using ISP proxy that previously triggered blocking
2. **Compare results**: Does Firefox get the "ZoomRequiresRtms" error or does it bypass?
3. **Monitor fingerprints**: Use `BROWSER_DEBUG_CAPTURE=true` to capture runtime fingerprints
4. **Document findings**: Record whether Firefox bypasses ISP blocking

## Branch Name

`feat/zoom-firefox-browser-recording`

## Related Work

- Original Chromium/CloakBrowser + ISP proxy implementation: `feat/zoom-browser-recording-v2`
- ISP proxy retry logic: See `src/proxy/toggle-proxy.ts` and retry handling in `main.ts`
