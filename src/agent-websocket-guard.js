/** Shared Agent WebSocket bypass guard for both legacy and Agent Host bundles. */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export const AGENT_WS_GATE_MARKER = '__byokAgentWebSocketGateDisabled';
export const AGENT_WS_ORIGINS_MARKER = '__byokAgentWebSocketOriginsDisabled';

// Compatibility with the first Agent Host-only implementation already deployed.
const OLD_GATE_MARKER = '__byokAgentHostWebSocketGateDisabled';
const OLD_ORIGINS_MARKER = '__byokAgentHostWebSocketOriginsDisabled';
const DISABLED_WS_GATE = '__byok_disabled_nal_websocket_client';

function parseBundle(source, label) {
  try {
    return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  }
  catch (error) {
    throw new Error(`${label} JavaScript parse failed: ${error.message}`);
  }
}

function websocketAstInfo(source, label) {
  const ast = parseBundle(source, label);
  const gateLiterals = [];
  const acceptedOriginArrays = [];

  walk.simple(ast, {
    Literal(node) {
      if (node.value === 'nal_websocket_client') gateLiterals.push(node);
    },
    ArrayExpression(node) {
      const values = node.elements
        .filter(Boolean)
        .map(element => element.type === 'Literal' ? element.value : undefined);
      if (values.includes('https://api.playground.cursor.sh') && values.includes('https://api2.cursor.sh')) {
        acceptedOriginArrays.push(node);
      }
    },
  });

  return { gateLiterals, acceptedOriginArrays };
}

function hasGateMarker(source) {
  return source.includes(AGENT_WS_GATE_MARKER) || source.includes(OLD_GATE_MARKER);
}

function hasOriginsMarker(source) {
  return source.includes(AGENT_WS_ORIGINS_MARKER) || source.includes(OLD_ORIGINS_MARKER);
}

export function hasAgentWebSocketStack(source) {
  // Export name + protocol path is independent of feature-gate rollout values.
  // A renamed gate therefore fails closed instead of being mistaken for no WS.
  return source.includes('/agent/v1/run')
    && source.includes('createAgentRunWebSocketSelection');
}

export function isAgentWebSocketDisabled(source, label = 'Agent network bundle') {
  if (!hasAgentWebSocketStack(source)) return true;
  if (!hasGateMarker(source) || !hasOriginsMarker(source)) return false;
  const info = websocketAstInfo(source, label);
  return info.gateLiterals.length === 0 && info.acceptedOriginArrays.length === 0;
}

/** Disable both the Statsig gate lookup and accepted-origin resolver. */
export function disableAgentWebSocket(source, label = 'Agent network bundle') {
  if (!hasAgentWebSocketStack(source)) return { source, changed: false, required: false };
  if (isAgentWebSocketDisabled(source, label)) return { source, changed: false, required: true };

  const info = websocketAstInfo(source, label);
  const edits = [];

  if (!hasGateMarker(source)) {
    if (info.gateLiterals.length !== 1) {
      throw new Error(`${label}: expected one nal_websocket_client gate literal, found ${info.gateLiterals.length}`);
    }
    const gate = info.gateLiterals[0];
    edits.push({
      start: gate.start,
      end: gate.end,
      text: `${JSON.stringify(DISABLED_WS_GATE)}/*${AGENT_WS_GATE_MARKER}*/`,
    });
  }

  if (!hasOriginsMarker(source)) {
    if (info.acceptedOriginArrays.length !== 1) {
      throw new Error(`${label}: expected one Agent WebSocket accepted-origin set, found ${info.acceptedOriginArrays.length}`);
    }
    const origins = info.acceptedOriginArrays[0];
    edits.push({
      start: origins.start + 1,
      end: origins.end - 1,
      text: `/*${AGENT_WS_ORIGINS_MARKER}*/`,
    });
  }

  edits.sort((a, b) => b.start - a.start);
  let patched = source;
  for (const edit of edits) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  parseBundle(patched, `${label} (patched)`);
  if (!isAgentWebSocketDisabled(patched, label)) throw new Error(`${label}: WebSocket disable verification failed`);
  return { source: patched, changed: edits.length > 0, required: true };
}
