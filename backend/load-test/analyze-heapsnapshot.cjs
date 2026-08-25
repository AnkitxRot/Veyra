// One-off diagnostic analyzer for the memory-investigation milestone.
// Not part of the load-test harness proper — reads a .heapsnapshot file
// (Chrome DevTools format) and prints a self-size-by-constructor-name
// histogram, without needing Chrome DevTools itself. Read-only; does not
// modify the snapshot or any production code.
//
// Usage: node --max-old-space-size=6144 load-test/analyze-heapsnapshot.cjs <path-to-.heapsnapshot> [topN]
const fs = require("fs");

const file = process.argv[2];
const topN = Number(process.argv[3] || 40);
if (!file) {
  console.error("usage: analyze-heapsnapshot.cjs <file.heapsnapshot> [topN]");
  process.exit(1);
}

console.error(`[analyze] reading ${file} ...`);
const raw = fs.readFileSync(file, "utf8");
console.error(`[analyze] parsing ${(raw.length / 1e6).toFixed(1)}MB of JSON ...`);
const snap = JSON.parse(raw);

const meta = snap.snapshot.meta;
const nodeFields = meta.node_fields; // e.g. ["type","name","id","self_size","edge_count","trace_node_id","detachedness"]
const nodeTypes = meta.node_types[0]; // enum values for the "type" field
const typeIdx = nodeFields.indexOf("type");
const nameIdx = nodeFields.indexOf("name");
const selfSizeIdx = nodeFields.indexOf("self_size");
const nodeFieldCount = nodeFields.length;

const strings = snap.strings;
const nodes = snap.nodes;
const totalNodes = nodes.length / nodeFieldCount;

console.error(`[analyze] ${totalNodes} nodes, ${strings.length} strings`);

// Aggregate self_size by (type:name) label. For "object" type nodes, name
// is the constructor name (e.g., "Y.Doc", "WebSocket", "Array", "Object");
// for "closure" it's the function name; for "string"/"concatenated string"
// grouping just by type is more useful than by content.
const byLabel = new Map();
let totalSelfSize = 0;
for (let i = 0; i < nodes.length; i += nodeFieldCount) {
  const typeId = nodes[i + typeIdx];
  const nameId = nodes[i + nameIdx];
  const selfSize = nodes[i + selfSizeIdx];
  totalSelfSize += selfSize;
  const typeName = nodeTypes[typeId] ?? `type${typeId}`;
  let label;
  if (typeName === "string" || typeName === "concatenated string" || typeName === "sliced string") {
    label = `[string]`;
  } else {
    const name = strings[nameId] ?? `#${nameId}`;
    label = `${typeName}:${name}`;
  }
  const entry = byLabel.get(label) ?? { count: 0, selfSize: 0 };
  entry.count++;
  entry.selfSize += selfSize;
  byLabel.set(label, entry);
}

const sorted = [...byLabel.entries()].sort((a, b) => b[1].selfSize - a[1].selfSize);
console.log(`\n=== ${file} ===`);
console.log(`Total self size: ${(totalSelfSize / 1e6).toFixed(1)}MB across ${totalNodes} nodes\n`);
console.log("count".padStart(10), "selfSizeMB".padStart(12), "  label");
for (let i = 0; i < Math.min(topN, sorted.length); i++) {
  const [label, entry] = sorted[i];
  console.log(
    String(entry.count).padStart(10),
    (entry.selfSize / 1e6).toFixed(2).padStart(12),
    "  " + label,
  );
}
