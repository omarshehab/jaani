const https = require('https');
const fs = require('fs');

const TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = 'QgZHdkJE7eKCPFV0lDxPhK';
const NODE_ID = '51-276';
const OUTPUT = 'scripts/figma_master_design.json';

if (!TOKEN) {
  console.error('Missing FIGMA_TOKEN environment variable.');
  process.exit(1);
}

https
  .get(
    `https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=${NODE_ID}`,
    { headers: { 'X-Figma-Token': TOKEN } },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        fs.writeFileSync(OUTPUT, data);
        console.log('JAANI FIGMA DESIGN DOWNLOADED — PIXEL PERFECTION UNLOCKED');
      });
    }
  )
  .on('error', (e) => console.error('Error:', e));

