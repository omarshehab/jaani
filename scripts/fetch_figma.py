#!/usr/bin/env python3

"""
Figma API Integration Script for X_Files (Python Version)
Fetches design data from Figma and saves as JSON for React component generation
"""

import requests
import json
import sys
import os
from datetime import datetime
from typing import Dict, Any, List, Optional

# Configuration
CONFIG = {
    'FIGMA_TOKEN': os.getenv('FIGMA_TOKEN', ''),
    'FILE_KEY': 'QgZHdkJE7eKCPFV0lDxPhK',
    'NODE_ID': '6-116',
    'API_BASE': 'https://api.figma.com/v1',
    'OUTPUT_FILE': 'figma_home.json',
    'TIMEOUT': 30
}

class FigmaAPI:
    """Figma API client for fetching design data"""
    
    def __init__(self, token: str):
        self.token = token
        self.headers = {
            'X-Figma-Token': token,
            'User-Agent': 'X_Files-Figma-Integration/1.0'
        }
        self.session = requests.Session()
        self.session.headers.update(self.headers)
    
    def fetch_file(self, file_key: str) -> Dict[str, Any]:
        """Fetch full Figma file data"""
        print('🔄 Fetching Figma file data...')
        url = f"{CONFIG['API_BASE']}/files/{file_key}"
        
        try:
            response = self.session.get(url, timeout=CONFIG['TIMEOUT'])
            response.raise_for_status()
            
            file_data = response.json()
            print('✅ Figma file fetched successfully')
            print(f"📄 File name: {file_data.get('name', 'Unknown')}")
            print(f"📅 Last modified: {file_data.get('lastModified', 'Unknown')}")
            print(f"🎨 Pages: {len(file_data.get('document', {}).get('children', []))}")
            
            return file_data
            
        except requests.exceptions.RequestException as e:
            print(f'❌ Error fetching Figma file: {e}')
            raise
    
    def fetch_node(self, file_key: str, node_id: str) -> Dict[str, Any]:
        """Fetch specific node data"""
        print('🔄 Fetching specific node data...')
        url = f"{CONFIG['API_BASE']}/files/{file_key}/nodes"
        params = {'ids': node_id}
        
        try:
            response = self.session.get(url, params=params, timeout=CONFIG['TIMEOUT'])
            response.raise_for_status()
            
            node_data = response.json()
            print('✅ Node data fetched successfully')
            
            if 'nodes' in node_data and node_id in node_data['nodes']:
                node = node_data['nodes'][node_id]
                print(f"🎯 Node name: {node.get('document', {}).get('name', 'Unknown')}")
                print(f"📐 Node type: {node.get('document', {}).get('type', 'Unknown')}")
                print(f"🔍 Node ID: {node_id}")
            
            return node_data
            
        except requests.exceptions.RequestException as e:
            print(f'❌ Error fetching node data: {e}')
            raise
    
    def parse_design_specs(self, file_data: Dict[str, Any], node_data: Dict[str, Any]) -> Dict[str, Any]:
        """Parse Figma data and extract design specifications"""
        print('🔄 Parsing design specifications...')
        
        specs = {
            'metadata': {
                'fileName': file_data.get('name', 'Unknown'),
                'lastModified': file_data.get('lastModified', 'Unknown'),
                'nodeId': CONFIG['NODE_ID'],
                'nodeName': node_data.get('nodes', {}).get(CONFIG['NODE_ID'], {}).get('document', {}).get('name', 'Unknown'),
                'extractedAt': datetime.now().isoformat()
            },
            'colors': {},
            'typography': {},
            'spacing': {},
            'components': {},
            'layout': {}
        }
        
        # Extract colors from styles
        styles = file_data.get('styles', {})
        for style_id, style in styles.items():
            if style.get('styleType') == 'FILL':
                specs['colors'][style.get('name', f'color_{style_id}')] = {
                    'id': style_id,
                    'description': style.get('description', ''),
                    'styleType': style.get('styleType')
                }
        
        # Extract component specifications
        node = node_data.get('nodes', {}).get(CONFIG['NODE_ID'], {})
        if 'document' in node:
            specs['components'] = self._extract_component_specs(node['document'])
        
        print('✅ Design specifications parsed')
        print(f"🎨 Colors found: {len(specs['colors'])}")
        print(f"📝 Components found: {len(specs['components'])}")
        
        return specs
    
    def _extract_component_specs(self, node: Dict[str, Any], path: str = '') -> Dict[str, Any]:
        """Extract component specifications from Figma node"""
        components = {}
        
        def traverse_node(current_node: Dict[str, Any], current_path: str = ''):
            node_name = current_node.get('name', 'unnamed')
            full_path = f"{current_path}.{node_name}" if current_path else node_name
            
            node_type = current_node.get('type', '')
            if node_type in ['FRAME', 'COMPONENT', 'INSTANCE']:
                components[full_path] = {
                    'type': node_type,
                    'name': node_name,
                    'absoluteBoundingBox': current_node.get('absoluteBoundingBox'),
                    'constraints': current_node.get('constraints'),
                    'fills': current_node.get('fills', []),
                    'strokes': current_node.get('strokes', []),
                    'effects': current_node.get('effects', []),
                    'children': []
                }
                
                # Extract text properties
                if node_type == 'TEXT':
                    components[full_path]['textProperties'] = {
                        'characters': current_node.get('characters', ''),
                        'style': current_node.get('style', {}),
                        'characterStyleOverrides': current_node.get('characterStyleOverrides', [])
                    }
                
                # Extract layout properties
                if 'layoutMode' in current_node:
                    components[full_path]['layout'] = {
                        'layoutMode': current_node.get('layoutMode'),
                        'primaryAxisAlignItems': current_node.get('primaryAxisAlignItems'),
                        'counterAxisAlignItems': current_node.get('counterAxisAlignItems'),
                        'paddingLeft': current_node.get('paddingLeft'),
                        'paddingRight': current_node.get('paddingRight'),
                        'paddingTop': current_node.get('paddingTop'),
                        'paddingBottom': current_node.get('paddingBottom'),
                        'itemSpacing': current_node.get('itemSpacing')
                    }
            
            # Traverse children
            children = current_node.get('children', [])
            for child in children:
                traverse_node(child, full_path)
                if full_path in components:
                    components[full_path]['children'].append(child.get('name', 'unnamed'))
        
        traverse_node(node)
        return components
    
    def generate_component_suggestions(self, specs: Dict[str, Any]) -> Dict[str, Any]:
        """Generate React component suggestions"""
        print('🔄 Generating React component suggestions...')
        
        suggestions = {
            'components': [],
            'styles': {},
            'recommendations': []
        }
        
        # Analyze components and suggest React equivalents
        for name, component in specs['components'].items():
            if component.get('type') == 'FRAME':
                layout = component.get('layout', {})
                suggestions['components'].append({
                    'figmaName': name,
                    'reactComponent': 'Box',
                    'muiProps': {
                        'sx': {
                            'width': component.get('absoluteBoundingBox', {}).get('width'),
                            'height': component.get('absoluteBoundingBox', {}).get('height'),
                            'display': 'flex',
                            'flexDirection': 'column' if layout.get('layoutMode') == 'VERTICAL' else 'row',
                            'alignItems': layout.get('counterAxisAlignItems', '').lower(),
                            'justifyContent': layout.get('primaryAxisAlignItems', '').lower(),
                            'padding': f"{layout.get('paddingTop', 0)}px {layout.get('paddingRight', 0)}px {layout.get('paddingBottom', 0)}px {layout.get('paddingLeft', 0)}px",
                            'gap': layout.get('itemSpacing', 0)
                        }
                    }
                })
        
        # Generate color palette
        for name, color in specs['colors'].items():
            suggestions['styles'][name] = {
                'figmaName': name,
                'suggestedUsage': self._get_color_usage(name),
                'muiColor': self._map_to_mui_color(name)
            }
        
        # Generate recommendations
        suggestions['recommendations'] = [
            'Use Material-UI theme with extracted colors',
            'Implement responsive breakpoints based on Figma frames',
            'Add internationalization support for text content',
            'Create reusable components for form elements',
            'Implement proper accessibility attributes'
        ]
        
        print('✅ Component suggestions generated')
        return suggestions
    
    def _get_color_usage(self, color_name: str) -> str:
        """Get suggested color usage"""
        usage_map = {
            'primary': 'Primary brand color for buttons and accents',
            'secondary': 'Secondary actions and highlights',
            'background': 'Main background color',
            'surface': 'Card and surface backgrounds',
            'text': 'Primary text color',
            'text-secondary': 'Secondary text color',
            'error': 'Error states and validation',
            'success': 'Success states and confirmations',
            'warning': 'Warning states and alerts'
        }
        
        return usage_map.get(color_name.lower(), 'Custom color - define usage')
    
    def _map_to_mui_color(self, color_name: str) -> str:
        """Map Figma color to MUI color"""
        mui_map = {
            'primary': 'primary.main',
            'secondary': 'secondary.main',
            'background': 'background.default',
            'surface': 'background.paper',
            'text': 'text.primary',
            'text-secondary': 'text.secondary',
            'error': 'error.main',
            'success': 'success.main',
            'warning': 'warning.main'
        }
        
        return mui_map.get(color_name.lower(), 'custom')
    
    def save_to_file(self, data: Dict[str, Any], filename: str) -> None:
        """Save data to JSON file"""
        try:
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            
            file_size = len(json.dumps(data, indent=2)) / 1024
            print(f"💾 Data saved to {filename}")
            print(f"📊 File size: {file_size:.2f} KB")
            
        except Exception as e:
            print(f'❌ Error saving file: {e}')
            raise

def main():
    """Main execution function"""
    print('🚀 X_Files Figma Integration Script (Python)')
    print('=============================================\n')
    
    try:
        # Validate token
        if not CONFIG['FIGMA_TOKEN'] or len(CONFIG['FIGMA_TOKEN']) < 10:
            raise ValueError('Invalid Figma token provided')
        
        # Initialize API client
        api = FigmaAPI(CONFIG['FIGMA_TOKEN'])
        
        # Fetch data
        file_data = api.fetch_file(CONFIG['FILE_KEY'])
        node_data = api.fetch_node(CONFIG['FILE_KEY'], CONFIG['NODE_ID'])
        
        # Parse specifications
        specs = api.parse_design_specs(file_data, node_data)
        
        # Generate suggestions
        suggestions = api.generate_component_suggestions(specs)
        
        # Combine all data
        output_data = {
            'figmaData': {
                'file': file_data,
                'node': node_data
            },
            'specifications': specs,
            'suggestions': suggestions,
            'integration': {
                'nextSteps': [
                    'Review extracted specifications',
                    'Generate React components',
                    'Implement Material-UI theme',
                    'Add internationalization',
                    'Test with sample URL'
                ],
                'filesToUpdate': [
                    'src/components/NewsInput.js',
                    'src/theme/theme.js',
                    'src/i18n/en.json',
                    'src/i18n/bn.json'
                ]
            }
        }
        
        # Save to file
        api.save_to_file(output_data, CONFIG['OUTPUT_FILE'])
        
        print('\n🎉 Figma integration completed successfully!')
        print('\n📋 Next Steps:')
        print('1. Review figma_home.json for design specifications')
        print('2. Generate React components based on extracted data')
        print('3. Implement Material-UI theme with Figma colors')
        print('4. Add internationalization support')
        print('5. Test with sample URL: https://prothomalo.com/politics/2025-10-24-scandal')
        
    except Exception as e:
        print(f'\n💥 Figma integration failed: {e}')
        
        if '403' in str(e):
            print('\n🔧 Troubleshooting:')
            print('- Check if Figma token is valid and has proper permissions')
            print('- Verify file access permissions')
            print('- Ensure token has not expired')
        
        sys.exit(1)

if __name__ == '__main__':
    main()
