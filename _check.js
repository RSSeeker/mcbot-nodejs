const fs = require('fs');
const path = require('path');

const entitiesPath = 'd:/vscode/mcbot-nodejs/node_modules/prismarine-viewer/viewer/lib/entities.js';
let content = fs.readFileSync(entitiesPath, 'utf8');

// Check for canvas usage
if (content.includes('createCanvas')) {
  console.log('FOUND createCanvas in entities.js');
  const idx = content.indexOf('createCanvas');
  console.log('Context:', content.substring(Math.max(0, idx - 30), idx + 80));
} else {
  console.log('NOT FOUND');
}

// Check for entity name lookup
if (content.includes('entity.name')) {
  console.log('FOUND entity.name');
  const idx = content.indexOf('entity.name');
  console.log('Context:', content.substring(Math.max(0, idx - 30), idx + 80));
}