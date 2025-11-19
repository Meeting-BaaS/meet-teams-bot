# Speaker ID Utilities

## Overview

This directory contains speaker ID generation utilities used for stable participant identification across both Node.js and browser contexts.

## Architecture

### Single Source of Truth

**`speaker-id.ts`** is the canonical source for all speaker ID logic:
- 64-bit hash implementation (FNV-1a-based)
- Sequential ID management
- Used directly in Node.js contexts

### Browser Bundle

**`browser-speaker-utils.js`** is AUTO-GENERATED from `speaker-id.ts`:
- Compiled for browser compatibility
- Wrapped in IIFE and exposed to `window.__speakerUtils`
- **DO NOT EDIT MANUALLY** - changes will be overwritten

## Building

### Generate Browser Bundle

```bash
npm run build:browser-utils
```

This compiles `speaker-id.ts` → `browser-speaker-utils.js` for browser injection.

### Automatic Build

The browser bundle is automatically generated during the main build:

```bash
npm run build  # Runs build:browser-utils first
```

## Usage

### Node.js Context

```typescript
import { generateStableUserId, createSequentialIdManager } from './speaker-id'

const userId = generateStableUserId('John Doe')
```

### Browser Context

The browser bundle is injected via Playwright:

```typescript
await page.addScriptTag({ path: 'browser-speaker-utils.js' })

// Then in browser code:
const userId = window.__speakerUtils.generateStableUserId('John Doe')
```

## Implementation Details

### Hash Algorithm

- **Type**: 64-bit hash (simulated with two 32-bit integers)
- **Algorithm**: FNV-1a variant adapted for 64-bit
- **Output**: 16-character hex string (8 chars per 32-bit value)
- **Collision resistance**: Excellent for participant name/email uniqueness

### Sequential IDs

Maps stable hash IDs to sequential numeric IDs (1, 2, 3...) to:
- Provide human-friendly IDs
- Maintain stability across rejoins
- Support UI display

## Maintenance

⚠️ **Important**: Only edit `speaker-id.ts`. The browser bundle is generated automatically.

If you need to modify speaker ID logic:
1. Edit `speaker-id.ts`
2. Run `npm run build:browser-utils`
3. Test in both Node.js and browser contexts
4. Commit both files

## Testing

To verify both implementations produce identical outputs:

```bash
npm test -- speaker-id.test.ts
```

(Test file to be added)
