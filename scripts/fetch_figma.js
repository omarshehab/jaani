#!/usr/bin/env node

/**
 * Figma API Integration Script for X_Files
 * Fetches design data from Figma and saves as JSON for React component generation
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  FIGMA_TOKEN: process.env.FIGMA_TOKEN || '',
  FILE_KEY: 'QgZHdkJE7eKCPFV0lDxPhK',
  NODE_ID: '51-276',
  API_BASE: 'https://api.figma.com/v1',
  OUTPUT_FILE: 'figma_master_design.json',
  TIMEOUT: 30000
};

/**
 * Make HTTPS request to Figma API
 */
function makeFigmaRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.figma.com',
      port: 443,
      path: endpoint,
      method: 'GET',
      headers: {
        'X-Figma-Token': CONFIG.FIGMA_TOKEN,
        'User-Agent': 'X_Files-Figma-Integration/1.0'
      },
      timeout: CONFIG.TIMEOUT
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(jsonData);
          } else {
            reject(new Error(`API Error ${res.statusCode}: ${jsonData.message || 'Unknown error'}`));
          }
        } catch (error) {
          reject(new Error(`JSON Parse Error: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request Error: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Fetch full Figma file data
 */
async function fetchFigmaFile() {
  console.log('🔄 Fetching Figma file data...');
  const endpoint = `/files/${CONFIG.FILE_KEY}`;
  
  try {
    const fileData = await makeFigmaRequest(endpoint);
    console.log('✅ Figma file fetched successfully');
    console.log(`📄 File name: ${fileData.name}`);
    console.log(`📅 Last modified: ${fileData.lastModified}`);
    console.log(`🎨 Pages: ${fileData.document.children.length}`);
    
    return fileData;
  } catch (error) {
    console.error('❌ Error fetching Figma file:', error.message);
    throw error;
  }
}

/**
 * Fetch specific node data
 */
async function fetchNodeData() {
  console.log('🔄 Fetching specific node data...');
  const endpoint = `/files/${CONFIG.FILE_KEY}/nodes?ids=${CONFIG.NODE_ID}`;
  
  try {
    const nodeData = await makeFigmaRequest(endpoint);
    console.log('✅ Node data fetched successfully');
    
    if (nodeData.nodes && nodeData.nodes[CONFIG.NODE_ID]) {
      const node = nodeData.nodes[CONFIG.NODE_ID];
      console.log(`🎯 Node name: ${node.document.name}`);
      console.log(`📐 Node type: ${node.document.type}`);
      console.log(`🔍 Node ID: ${CONFIG.NODE_ID}`);
    }
    
    return nodeData;
  } catch (error) {
    console.error('❌ Error fetching node data:', error.message);
    throw error;
  }
}

/**
 * Parse Figma data and extract design specifications
 */
function parseDesignSpecs(fileData, nodeData) {
  console.log('🔄 Parsing design specifications...');
  
  const specs = {
    metadata: {
      fileName: fileData.name,
      lastModified: fileData.lastModified,
      nodeId: CONFIG.NODE_ID,
      nodeName: nodeData.nodes[CONFIG.NODE_ID]?.document?.name || 'Unknown',
      extractedAt: new Date().toISOString()
    },
    colors: {},
    typography: {},
    spacing: {},
    components: {},
    layout: {}
  };

  // Extract colors from styles
  if (fileData.styles) {
    Object.entries(fileData.styles).forEach(([styleId, style]) => {
      if (style.styleType === 'FILL') {
        specs.colors[style.name] = {
          id: styleId,
          description: style.description || '',
          styleType: style.styleType
        };
      }
    });
  }

  // Extract component specifications
  const node = nodeData.nodes[CONFIG.NODE_ID];
  if (node && node.document) {
    specs.components = extractComponentSpecs(node.document);
  }

  console.log('✅ Design specifications parsed');
  console.log(`🎨 Colors found: ${Object.keys(specs.colors).length}`);
  console.log(`📝 Components found: ${Object.keys(specs.components).length}`);

  return specs;
}

/**
 * Extract component specifications from Figma node
 */
function extractComponentSpecs(node) {
  const components = {};

  function traverseNode(node, path = '') {
    const currentPath = path ? `${path}.${node.name}` : node.name;
    
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      components[currentPath] = {
        type: node.type,
        name: node.name,
        absoluteBoundingBox: node.absoluteBoundingBox,
        constraints: node.constraints,
        fills: node.fills,
        strokes: node.strokes,
        effects: node.effects,
        children: []
      };

      // Extract text properties
      if (node.type === 'TEXT') {
        components[currentPath].textProperties = {
          characters: node.characters,
          style: node.style,
          characterStyleOverrides: node.characterStyleOverrides
        };
      }

      // Extract layout properties
      if (node.layoutMode) {
        components[currentPath].layout = {
          layoutMode: node.layoutMode,
          primaryAxisAlignItems: node.primaryAxisAlignItems,
          counterAxisAlignItems: node.counterAxisAlignItems,
          paddingLeft: node.paddingLeft,
          paddingRight: node.paddingRight,
          paddingTop: node.paddingTop,
          paddingBottom: node.paddingBottom,
          itemSpacing: node.itemSpacing
        };
      }
    }

    // Traverse children
    if (node.children) {
      node.children.forEach(child => {
        traverseNode(child, currentPath);
        if (components[currentPath]) {
          components[currentPath].children.push(child.name);
        }
      });
    }
  }

  traverseNode(node);
  return components;
}

/**
 * Save data to JSON file
 */
function saveToFile(data, filename) {
  try {
    const jsonString = JSON.stringify(data, null, 2);
    fs.writeFileSync(filename, jsonString, 'utf8');
    console.log(`💾 Data saved to ${filename}`);
    console.log(`📊 File size: ${(jsonString.length / 1024).toFixed(2)} KB`);
  } catch (error) {
    console.error('❌ Error saving file:', error.message);
    throw error;
  }
}

/**
 * Generate React component suggestions
 */
function generateComponentSuggestions(specs) {
  console.log('🔄 Generating React component suggestions...');
  
  const suggestions = {
    components: [],
    styles: {},
    recommendations: []
  };

  // Analyze components and suggest React equivalents
  Object.entries(specs.components).forEach(([name, component]) => {
    if (component.type === 'FRAME') {
      suggestions.components.push({
        figmaName: name,
        reactComponent: 'Box',
        muiProps: {
          sx: {
            width: component.absoluteBoundingBox?.width,
            height: component.absoluteBoundingBox?.height,
            display: 'flex',
            flexDirection: component.layout?.layoutMode === 'VERTICAL' ? 'column' : 'row',
            alignItems: component.layout?.counterAxisAlignItems?.toLowerCase(),
            justifyContent: component.layout?.primaryAxisAlignItems?.toLowerCase(),
            padding: `${component.layout?.paddingTop || 0}px ${component.layout?.paddingRight || 0}px ${component.layout?.paddingBottom || 0}px ${component.layout?.paddingLeft || 0}px`,
            gap: component.layout?.itemSpacing || 0
          }
        }
      });
    }
  });

  // Generate color palette
  Object.entries(specs.colors).forEach(([name, color]) => {
    suggestions.styles[name] = {
      figmaName: name,
      suggestedUsage: getColorUsage(name),
      muiColor: mapToMUIColor(name)
    };
  });

  // Generate recommendations
  suggestions.recommendations = [
    'Use Material-UI theme with extracted colors',
    'Implement responsive breakpoints based on Figma frames',
    'Add internationalization support for text content',
    'Create reusable components for form elements',
    'Implement proper accessibility attributes'
  ];

  console.log('✅ Component suggestions generated');
  return suggestions;
}

/**
 * Get suggested color usage
 */
function getColorUsage(colorName) {
  const usageMap = {
    'primary': 'Primary brand color for buttons and accents',
    'secondary': 'Secondary actions and highlights',
    'background': 'Main background color',
    'surface': 'Card and surface backgrounds',
    'text': 'Primary text color',
    'text-secondary': 'Secondary text color',
    'error': 'Error states and validation',
    'success': 'Success states and confirmations',
    'warning': 'Warning states and alerts'
  };
  
  return usageMap[colorName.toLowerCase()] || 'Custom color - define usage';
}

/**
 * Map Figma color to MUI color
 */
function mapToMUIColor(colorName) {
  const muiMap = {
    'primary': 'primary.main',
    'secondary': 'secondary.main',
    'background': 'background.default',
    'surface': 'background.paper',
    'text': 'text.primary',
    'text-secondary': 'text.secondary',
    'error': 'error.main',
    'success': 'success.main',
    'warning': 'warning.main'
  };
  
  return muiMap[colorName.toLowerCase()] || 'custom';
}

/**
 * Main execution function
 */
async function main() {
  console.log('🚀 X_Files Figma Integration Script');
  console.log('=====================================\n');

  try {
    // Validate token
    if (!CONFIG.FIGMA_TOKEN || CONFIG.FIGMA_TOKEN.length < 10) {
      throw new Error('Invalid Figma token provided');
    }

    // Fetch data
    const fileData = await fetchFigmaFile();
    const nodeData = await fetchNodeData();

    // Parse specifications
    const specs = parseDesignSpecs(fileData, nodeData);

    // Generate suggestions
    const suggestions = generateComponentSuggestions(specs);

    // Combine all data
    const outputData = {
      figmaData: {
        file: fileData,
        node: nodeData
      },
      specifications: specs,
      suggestions: suggestions,
      integration: {
        nextSteps: [
          'Review extracted specifications',
          'Generate React components',
          'Implement Material-UI theme',
          'Add internationalization',
          'Test with sample URL'
        ],
        filesToUpdate: [
          'src/components/NewsInput.js',
          'src/theme/theme.js',
          'src/i18n/en.json',
          'src/i18n/bn.json'
        ]
      }
    };

    // Save to file
    saveToFile(outputData, CONFIG.OUTPUT_FILE);

    console.log('\n🎉 Figma integration completed successfully!');
    console.log('\n📋 Next Steps:');
    console.log('1. Review figma_home.json for design specifications');
    console.log('2. Generate React components based on extracted data');
    console.log('3. Implement Material-UI theme with Figma colors');
    console.log('4. Add internationalization support');
    console.log('5. Test with sample URL: https://prothomalo.com/politics/2025-10-24-scandal');

  } catch (error) {
    console.error('\n💥 Figma integration failed:', error.message);
    
    if (error.message.includes('403')) {
      console.log('\n🔧 Troubleshooting:');
      console.log('- Check if Figma token is valid and has proper permissions');
      console.log('- Verify file access permissions');
      console.log('- Ensure token has not expired');
    }
    
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  fetchFigmaFile,
  fetchNodeData,
  parseDesignSpecs,
  generateComponentSuggestions
};
