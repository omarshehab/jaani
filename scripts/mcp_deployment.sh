#!/bin/bash

# MCP Server Deployment Commands for X_Files Figma Integration
# Execute these commands to deploy and run the Figma integration on MCP server

echo "🚀 X_Files Figma Integration - MCP Server Deployment"
echo "===================================================="

# Configuration
MCP_SERVER="mcp-server.com"
MCP_USER="user"
LOCAL_PROJECT_PATH="./x_files"
REMOTE_PATH="~/x_files"

# Step 1: Connect to MCP server
echo "📡 Step 1: Connecting to MCP server..."
echo "Command: ssh $MCP_USER@$MCP_SERVER"
echo ""
echo "Once connected, run these commands on the MCP server:"
echo ""

# Step 2: Upload files to MCP server
echo "📤 Step 2: Uploading files to MCP server..."
echo "Commands to run locally:"
echo ""

echo "# Upload the entire project"
echo "scp -r $LOCAL_PROJECT_PATH $MCP_USER@$MCP_SERVER:$REMOTE_PATH"
echo ""

echo "# Upload just the scripts"
echo "scp $LOCAL_PROJECT_PATH/scripts/fetch_figma.js $MCP_USER@$MCP_SERVER:~/"
echo "scp $LOCAL_PROJECT_PATH/scripts/fetch_figma.py $MCP_USER@$MCP_SERVER:~/"
echo ""

# Step 3: Install dependencies on MCP server
echo "📦 Step 3: Installing dependencies on MCP server..."
echo "Commands to run on MCP server:"
echo ""

echo "# Install Node.js dependencies"
echo "cd ~/x_files && npm install"
echo ""

echo "# Install Python dependencies"
echo "pip3 install requests"
echo ""

# Step 4: Run the Figma integration script
echo "🔄 Step 4: Running Figma integration script..."
echo "Commands to run on MCP server:"
echo ""

echo "# Run Node.js version"
echo "cd ~/x_files && node scripts/fetch_figma.js"
echo ""

echo "# Or run Python version"
echo "cd ~/x_files && python3 scripts/fetch_figma.py"
echo ""

# Step 5: Download results
echo "📥 Step 5: Downloading results..."
echo "Commands to run locally:"
echo ""

echo "# Download the generated JSON file"
echo "scp $MCP_USER@$MCP_SERVER:~/x_files/figma_home.json ./"
echo ""

echo "# Download any generated components"
echo "scp -r $MCP_USER@$MCP_SERVER:~/x_files/generated_components/ ./"
echo ""

# Step 6: Verify and test
echo "✅ Step 6: Verification and testing..."
echo "Commands to run locally:"
echo ""

echo "# Verify the JSON file was created"
echo "ls -la figma_home.json"
echo ""

echo "# Check the file contents"
echo "head -20 figma_home.json"
echo ""

echo "# Test the integration"
echo "cd x_files && npm run start:all"
echo ""

# Complete deployment script
echo "📋 Complete Deployment Script:"
echo "================================"
echo ""

cat << 'EOF'
#!/bin/bash

# Complete MCP Server Deployment Script
set -e

# Configuration
MCP_SERVER="mcp-server.com"
MCP_USER="user"
PROJECT_NAME="x_files"

echo "🚀 Starting MCP Server Deployment..."

# Step 1: Upload project
echo "📤 Uploading project to MCP server..."
scp -r ./$PROJECT_NAME $MCP_USER@$MCP_SERVER:~/

# Step 2: Install dependencies
echo "📦 Installing dependencies..."
ssh $MCP_USER@$MCP_SERVER << 'SSH_EOF'
cd ~/$PROJECT_NAME
npm install
pip3 install requests
SSH_EOF

# Step 3: Run Figma integration
echo "🔄 Running Figma integration..."
ssh $MCP_USER@$MCP_SERVER << 'SSH_EOF'
cd ~/$PROJECT_NAME
node scripts/fetch_figma.js
SSH_EOF

# Step 4: Download results
echo "📥 Downloading results..."
scp $MCP_USER@$MCP_SERVER:~/figma_home.json ./

# Step 5: Verify
echo "✅ Verifying results..."
if [ -f "figma_home.json" ]; then
    echo "✅ figma_home.json created successfully"
    echo "📊 File size: $(du -h figma_home.json | cut -f1)"
else
    echo "❌ figma_home.json not found"
    exit 1
fi

echo "🎉 MCP Server deployment completed!"
EOF

echo ""
echo "🔧 Troubleshooting Commands:"
echo "============================"
echo ""

echo "# Check MCP server status"
echo "ssh $MCP_USER@$MCP_SERVER 'uptime'"
echo ""

echo "# Check disk space on MCP server"
echo "ssh $MCP_USER@$MCP_SERVER 'df -h'"
echo ""

echo "# Check if Node.js is installed"
echo "ssh $MCP_USER@$MCP_SERVER 'node --version'"
echo ""

echo "# Check if Python is installed"
echo "ssh $MCP_USER@$MCP_SERVER 'python3 --version'"
echo ""

echo "# View logs on MCP server"
echo "ssh $MCP_USER@$MCP_SERVER 'tail -f ~/x_files/logs/*.log'"
echo ""

echo "# Test API connectivity from MCP server"
echo "ssh $MCP_USER@$MCP_SERVER 'curl -I https://api.figma.com/v1'"
echo ""

echo "📝 Notes:"
echo "=========="
echo "- Replace 'mcp-server.com' and 'user' with your actual MCP server details"
echo "- Ensure your SSH key is set up for passwordless access"
echo "- The Figma token is embedded in the scripts - keep them secure"
echo "- Monitor the MCP server resources during execution"
echo "- Check the generated figma_home.json for design specifications"
