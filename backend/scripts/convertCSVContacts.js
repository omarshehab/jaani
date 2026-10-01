/**
 * CSV to JSON Contact Converter
 * Converts RTI officers CSV data to structured JSON contacts
 */

const fs = require('fs').promises;
const path = require('path');

// Parse CSV content
function parseCSV(content) {
  const lines = content.split('\n');
  const contacts = [];
  
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.split(',').every(cell => !cell.trim())) {
      continue; // Skip empty lines
    }
    
    // Parse CSV with proper handling of quoted fields
    const cells = parseCSVLine(line);
    
    if (cells.length < 12) continue; // Skip incomplete rows
    
    const [
      ministry,
      department,
      primaryOfficer,
      _empty1,
      primaryMobile,
      primaryEmail,
      alternateOfficer,
      _empty2,
      alternateDesignation,
      alternateMobile,
      alternateEmail,
      website,
      lastChecked
    ] = cells;
    
    // Skip rows without essential data
    if (!ministry.trim() && !primaryOfficer.trim()) continue;
    
    // Create primary officer contact
    if (primaryOfficer.trim()) {
      const contact = {
        name: cleanText(primaryOfficer),
        designation: cleanText(alternateDesignation) || 'দায়িত্বপ্রাপ্ত কর্মকর্তা',
        phone: cleanPhone(primaryMobile),
        email: cleanText(primaryEmail),
        office_name: cleanText(department) || cleanText(ministry) || 'সরকারী দপ্তর',
        ministry: cleanText(ministry) || cleanText(department),
        entityType: 'gov',
        verifyUrl: cleanText(website),
        sourceUrl: 'RTI Officers Database',
        photoUrl: '',
        lastChecked: cleanText(lastChecked)
      };
      
      if (contact.name && (contact.phone || contact.email)) {
        contacts.push(contact);
      }
    }
    
    // Create alternate officer contact
    if (alternateOfficer.trim()) {
      const contact = {
        name: cleanText(alternateOfficer),
        designation: cleanText(alternateDesignation) || 'বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা',
        phone: cleanPhone(alternateMobile),
        email: cleanText(alternateEmail),
        office_name: cleanText(department) || cleanText(ministry) || 'সরকারী দপ্তর',
        ministry: cleanText(ministry) || cleanText(department),
        entityType: 'gov',
        verifyUrl: cleanText(website),
        sourceUrl: 'RTI Officers Database',
        photoUrl: '',
        lastChecked: cleanText(lastChecked)
      };
      
      if (contact.name && (contact.phone || contact.email)) {
        contacts.push(contact);
      }
    }
  }
  
  return contacts;
}

// Parse a CSV line handling quoted fields properly
function parseCSVLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current); // Add last cell
  
  return cells;
}

// Clean and normalize text
function cleanText(text) {
  if (!text) return '';
  return text.trim()
    .replace(/^["']|["']$/g, '') // Remove quotes
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

// Clean and format phone numbers
function cleanPhone(phone) {
  if (!phone) return '';
  let cleaned = cleanText(phone);
  
  // Remove common prefixes and normalize
  cleaned = cleaned
    .replace(/^88-?0?/, '') // Remove country code
    .replace(/[^\d]/g, ''); // Keep only digits
  
  // Ensure it starts with 0 for BD numbers
  if (cleaned.length === 10 && !cleaned.startsWith('0')) {
    cleaned = '0' + cleaned;
  }
  
  return cleaned;
}

// Group contacts by ministry/department
function groupByMinistry(contacts) {
  const grouped = {};
  
  for (const contact of contacts) {
    const key = contact.ministry || contact.office_name || 'Other';
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(contact);
  }
  
  return grouped;
}

// Generate safe filename from organization name
function generateFilename(orgName) {
  return orgName
    .replace(/[^\u0980-\u09FFa-z0-9\s]/gi, '') // Keep Bengali, English, numbers
    .replace(/\s+/g, '_')
    .toLowerCase()
    .substring(0, 100) + '.json';
}

async function main() {
  try {
    console.log('🔄 Reading CSV file...');
    
    const csvPath = path.join(__dirname, '..', '..', 'RTI officers - Sheet3.csv');
    const csvContent = await fs.readFile(csvPath, 'utf8');
    
    console.log('📊 Parsing CSV data...');
    const contacts = parseCSV(csvContent);
    
    console.log(`✅ Extracted ${contacts.length} contacts`);
    
    // Create output directory
    const outputDir = path.join(__dirname, '..', 'data', 'scraped_contacts');
    await fs.mkdir(outputDir, { recursive: true });
    
    // Save all contacts
    const allContactsPath = path.join(outputDir, 'rti_officers_all.json');
    await fs.writeFile(allContactsPath, JSON.stringify(contacts, null, 2), 'utf8');
    console.log(`📁 Saved all contacts to: ${allContactsPath}`);
    
    // Group and save by ministry
    const grouped = groupByMinistry(contacts);
    console.log(`\n📂 Saving ${Object.keys(grouped).length} organization files...`);
    
    for (const [org, orgContacts] of Object.entries(grouped)) {
      const filename = generateFilename(org);
      const filepath = path.join(outputDir, filename);
      await fs.writeFile(filepath, JSON.stringify(orgContacts, null, 2), 'utf8');
      console.log(`  ✅ ${org}: ${orgContacts.length} contacts -> ${filename}`);
    }
    
    console.log('\n✨ Conversion complete!');
    console.log(`Total: ${contacts.length} contacts in ${Object.keys(grouped).length} organizations`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { parseCSV, groupByMinistry };
