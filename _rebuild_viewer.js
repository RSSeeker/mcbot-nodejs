const webpack = require('webpack');
const path = require('path');

const viewerDir = path.join(__dirname, 'node_modules', 'prismarine-viewer');
const configPath = path.join(viewerDir, 'webpack.config.js');
const config = require(configPath);

// Set the context to the prismarine-viewer directory
config[0].context = viewerDir;
config[1].context = viewerDir;

// Add canvas to externals for the index config
config[0].externals.push({
  canvas: 'canvas'
});

// Also add canvas to resolve.fallback
config[0].resolve.fallback.canvas = false;
config[1].resolve.fallback.canvas = false;
config[1].resolve.fallback.assert = false;
config[1].resolve.fallback.zlib = false;

webpack(config, (err, stats) => {
  if (err) {
    console.error('Webpack build error:', err);
    process.exit(1);
  }
  
  if (stats.hasErrors()) {
    console.error('Webpack compilation errors:');
    console.error(stats.toString({ colors: true }));
    process.exit(1);
  }
  
  console.log(stats.toString({ colors: true }));
  console.log('Build successful!');
});