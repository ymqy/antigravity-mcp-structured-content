/**
 * Shared Explicit Adapter Registry loader, timeout resolver, and lossless
 * structuredContent compactor.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = process.env.PLUGIN_ROOT || dirname(__dirname);
export const BUILTIN_REGISTRY_PATH = join(PLUGIN_ROOT, 'adapters', 'registry.json');
export const DEFAULT_CALL_TIMEOUT_MS =
  Number(process.env.AGY_MCP_SC_CALL_TIMEOUT_MS) || 10 * 60 * 1000;

export function getUserOverridePath() {
  return (
    process.env.AGY_MCP_SC_USER_CONFIG ||
    join(homedir(), '.gemini', 'config', 'mcp_structured_content.json')
  );
}

export function readJsonFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function loadRegistryAndAdapter(serverName) {
  const builtin = readJsonFile(BUILTIN_REGISTRY_PATH) || {};
  const user = readJsonFile(getUserOverridePath()) || {};

  const bridgeServerName =
    user.bridgeServerName ||
    builtin.bridgeServerName ||
    'antigravity-mcp-structured-content_bridge';
  const bridgeToolName =
    user.bridgeToolName || builtin.bridgeToolName || 'get_structured_result';

  const base = builtin.servers?.[serverName];
  const extra = user.servers?.[serverName];
  if (!base && !extra) {
    return { bridgeServerName, bridgeToolName, adapter: null };
  }
  const merged = { ...(base || {}), ...(extra || {}) };
  return {
    bridgeServerName,
    bridgeToolName,
    adapter: merged.enabled === false ? null : merged,
  };
}

/**
 * Resolve effective tool call timeout (ms) consistently across bridge_mcp and mcp_pool_daemon:
 * 1. Explicit per-request override (`explicitTimeoutMs`) if provided
 * 2. Per-server `adapter.callTimeoutMs` (allows both shorter fail-fast timeouts like 30s
 *    and longer timeouts)
 * 3. `DEFAULT_CALL_TIMEOUT_MS` (10 minutes, or `AGY_MCP_SC_CALL_TIMEOUT_MS`)
 * Extended automatically when `toolArgs.timeout_ms` / `toolArgs.timeoutMs` exceeds the base.
 */
export function resolveCallTimeoutMs(adapter, toolArgs, explicitTimeoutMs) {
  const reqMs = Number(explicitTimeoutMs);
  if (Number.isFinite(reqMs) && reqMs > 0) {
    return reqMs;
  }
  const adapterTimeout = Number(adapter?.callTimeoutMs);
  const base =
    Number.isFinite(adapterTimeout) && adapterTimeout > 0
      ? adapterTimeout
      : DEFAULT_CALL_TIMEOUT_MS;
  const argTimeout = Number(toolArgs?.timeout_ms ?? toolArgs?.timeoutMs);
  if (Number.isFinite(argTimeout) && argTimeout > 0) {
    return Math.max(base, argTimeout + 15000);
  }
  return base;
}

/**
 * Determine whether `(serverName, toolName)` should be routed through the
 * single-connection structuredContent bridge.
 */
export function shouldInterceptTool(adapter, toolName) {
  if (!adapter || adapter.enabled === false || !toolName) return false;
  if (Array.isArray(adapter.excludeTools) && adapter.excludeTools.includes(toolName)) {
    return false;
  }
  const spec = adapter.interceptTools;
  if (spec === '*') return true;
  if (Array.isArray(spec)) {
    return spec.includes('*') || spec.includes(toolName);
  }
  return false;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Build a set of exact relative dot-paths from `structuredContent` root to omit.
 *
 * Supported entry formats in `adapter.omitStructuredFields`:
 * - `"field"` -> omits root `sc.field` only (never nested `sc.other.field`)
 * - `"nested.field"` -> omits `sc.nested.field`
 * - `"items[].field"` -> omits `field` on objects inside `sc.items` array
 * - `"toolName:field"` or `"toolName:nested.field"` -> tool-scoped path
 * - `"toolName.field"` -> also accepted as tool-scoped when `toolName` is not a root key of `sc`
 */
function buildOmitPathSet(adapter, toolName, rootSc) {
  const omitPaths = new Set();
  const list = Array.isArray(adapter?.omitStructuredFields) ? adapter.omitStructuredFields : [];
  for (const item of list) {
    if (typeof item !== 'string' || !item) continue;
    const colon = item.indexOf(':');
    if (colon !== -1) {
      const targetTool = item.slice(0, colon);
      const relPath = item.slice(colon + 1);
      if (targetTool === toolName && relPath) {
        omitPaths.add(relPath);
      }
      continue;
    }
    const dot = item.indexOf('.');
    if (dot !== -1 && toolName && item.slice(0, dot) === toolName && !Object.hasOwn(rootSc, toolName)) {
      const relPath = item.slice(dot + 1);
      if (relPath) omitPaths.add(relPath);
      continue;
    }
    omitPaths.add(item);
  }
  return omitPaths;
}

function isRedundantStringField(key, value, fullText) {
  if (!fullText) return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > fullText.length) return false;

  // Always strip UI tree markdown duplicates regardless of window element count.
  if (key === 'tree_markdown' && fullText.includes(trimmed)) {
    return true;
  }

  // Strip multi-line blocks (>=24 chars) or long prose (>=80 chars) already present
  // verbatim in content[].text, while preserving short scalar IDs/codes/tokens/enums.
  if (
    (trimmed.length >= 80 || (trimmed.includes('\n') && trimmed.length >= 24)) &&
    fullText.includes(trimmed)
  ) {
    return true;
  }

  return false;
}

/**
 * Losslessly compact `structuredContent` against `content[]` text blocks:
 * - Removes large/multi-line prose fields (such as `tree_markdown` in `get_window_state`
 *   or `observation.state.tree_markdown` in `run_steps`) that are already verbatim
 *   present in `content[].text`, avoiding 2x token bloat.
 * - Suppresses `[structuredContent]` altogether when `structuredContent` only repeats
 *   `content[].text` (e.g. `page` returning `{"text": "..."}` identical to `content[0].text`).
 * - Preserves array lengths 100% intact while also stripping redundant duplicate prose
 *   fields inside plain objects nested within arrays.
 */
export function compactStructuredContent(sc, contentBlocks, adapter, toolName = '') {
  if (sc === undefined || sc === null) return undefined;
  if (!isPlainObject(sc)) return sc;

  const dedupeEnabled = adapter?.dedupeTextInContent !== false;
  const omitPaths = buildOmitPathSet(adapter, toolName, sc);

  const fullText =
    dedupeEnabled && Array.isArray(contentBlocks)
      ? contentBlocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim()
      : '';

  const rootKeys = Object.keys(sc);
  if (rootKeys.length === 0) {
    return sc;
  }

  if (dedupeEnabled && fullText && rootKeys.length === 1 && omitPaths.size === 0) {
    const onlyVal = sc[rootKeys[0]];
    if (typeof onlyVal === 'string' && onlyVal.trim() === fullText) {
      return undefined;
    }
  }

  function walkArray(arr, arrayPath) {
    let mutated = false;
    const nextArr = arr.map((item) => {
      if (isPlainObject(item)) {
        const cleanedItem = walkObject(item, `${arrayPath}[]`);
        if (cleanedItem !== item) mutated = true;
        return cleanedItem;
      }
      if (Array.isArray(item)) {
        const cleanedNested = walkArray(item, `${arrayPath}[]`);
        if (cleanedNested !== item) mutated = true;
        return cleanedNested;
      }
      return item;
    });
    return mutated ? nextArr : arr;
  }

  function walkObject(obj, prefix = '') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return obj;

    const out = {};
    for (const k of keys) {
      const fieldPath = prefix ? `${prefix}.${k}` : k;
      if (omitPaths.has(fieldPath)) continue;

      const v = obj[k];
      if (typeof v === 'string') {
        if (dedupeEnabled && isRedundantStringField(k, v, fullText)) {
          continue;
        }
        out[k] = v;
      } else if (isPlainObject(v)) {
        const origSubKeys = Object.keys(v);
        if (origSubKeys.length === 0) {
          out[k] = {};
        } else {
          const cleanedSub = walkObject(v, fieldPath);
          if (Object.keys(cleanedSub).length > 0) {
            out[k] = cleanedSub;
          }
        }
      } else if (Array.isArray(v)) {
        out[k] = walkArray(v, fieldPath);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  const compacted = walkObject(sc, '');
  if (Object.keys(compacted).length === 0) {
    return undefined;
  }
  return compacted;
}
