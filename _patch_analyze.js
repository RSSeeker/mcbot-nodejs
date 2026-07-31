const fs = require('fs');

const indexPath = 'd:/vscode/mcbot-nodejs/node_modules/prismarine-viewer/public/index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// Get first 200 chars and last 200 chars
const first = content.substring(0, 200);
const last = content.substring(content.length - 200);

// Find createCanvas with context
const idx = content.indexOf('createCanvas');
let context200 = '';
if (idx >= 0) {
  context200 = content.substring(Math.max(0, idx - 40), Math.min(content.length, idx + 200));
}

// Find the canvas module - look for module patterns
const canvasModuleIdx = content.indexOf('"canvas"');
let canvasModule200 = '';
if (canvasModuleIdx >= 0) {
  canvasModule200 = content.substring(Math.max(0, canvasModuleIdx - 40), Math.min(content.length, canvasModuleIdx + 200));
}

const output = `
=== First 200 chars ===
${first}

=== Last 200 chars ===
${last}

=== createCanvas context ===
${context200}

=== canvas module context ===
${canvasModule200}

=== File size ===
${content.length}
`;

fs.writeFileSync('d:/vscode/mcbot-nodejs/_analysis_output.txt', output);
console.log('Done');