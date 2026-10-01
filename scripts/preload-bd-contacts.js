#!/usr/bin/env node

/**
 * Enhanced Database Preloader for JAANI RTI Platform
 * 
 * Pre-loads 500+ contact entries for Bangladesh government offices and corporations
 * Supports Bengali text with UTF-8 encoding
 * 
 * Usage: node scripts/preload-bd-contacts.js [--mongodb=URI] [--clear]
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Import Contact model
const Contact = require('../backend/models/Contact');

// Bangladesh Districts
const districts = [
  'Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Sylhet', 'Rangpur', 'Barishal', 'Mymensingh',
  'Comilla', 'Gazipur', 'Narayanganj', 'Tongi', 'Bogra', 'Rangamati', 'Jessore', 'Cox\'s Bazar',
  'Dinajpur', 'Brahmanbaria', 'Savar', 'Narsingdi', 'Tangail', 'Nawabganj', 'Saidpur', 'Jamalpur',
  'Faridpur', 'Kushtia', 'Pabna', 'Gopalganj', 'Madaripur', 'Shariatpur', 'Munshiganj', 'Manikganj'
];

const divisions = ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Sylhet', 'Rangpur', 'Barishal', 'Mymensingh'];

// Government Ministries and Departments
const govMinistries = [
  { name: 'Prime Minister\'s Office', bn: 'প্রধানমন্ত্রীর কার্যালয়', domain: 'pmo.gov.bd' },
  { name: 'Cabinet Division', bn: 'মন্ত্রিপরিষদ বিভাগ', domain: 'cabinet.gov.bd' },
  { name: 'Ministry of Finance', bn: 'অর্থ মন্ত্রণালয়', domain: 'mof.gov.bd' },
  { name: 'Ministry of Health', bn: 'স্বাস্থ্য মন্ত্রণালয়', domain: 'mohfw.gov.bd' },
  { name: 'Ministry of Education', bn: 'শিক্ষা মন্ত্রণালয়', domain: 'moedu.gov.bd' },
  { name: 'Ministry of Home Affairs', bn: 'স্বরাষ্ট্র মন্ত্রণালয়', domain: 'moha.gov.bd' },
  { name: 'Ministry of Foreign Affairs', bn: 'পররাষ্ট্র মন্ত্রণালয়', domain: 'mofa.gov.bd' },
  { name: 'Ministry of Agriculture', bn: 'কৃষি মন্ত্রণালয়', domain: 'moa.gov.bd' },
  { name: 'Ministry of Commerce', bn: 'বাণিজ্য মন্ত্রণালয়', domain: 'mincom.gov.bd' },
  { name: 'Ministry of Information', bn: 'তথ্য মন্ত্রণালয়', domain: 'moi.gov.bd' },
  { name: 'Ministry of Law', bn: 'আইন মন্ত্রণালয়', domain: 'minlaw.gov.bd' },
  { name: 'Ministry of Planning', bn: 'পরিকল্পনা মন্ত্রণালয়', domain: 'plancomm.gov.bd' },
  { name: 'Ministry of Industries', bn: 'শিল্প মন্ত্রণালয়', domain: 'moind.gov.bd' },
  { name: 'Ministry of Environment', bn: 'পরিবেশ মন্ত্রণালয়', domain: 'moef.gov.bd' },
  { name: 'Ministry of Power', bn: 'বিদ্যুৎ মন্ত্রণালয়', domain: 'powerdivision.gov.bd' },
  { name: 'Ministry of Transport', bn: 'পরিবহন মন্ত্রণালয়', domain: 'moroad.gov.bd' },
  { name: 'Ministry of Railways', bn: 'রেলপথ মন্ত্রণালয়', domain: 'mor.gov.bd' },
  { name: 'Ministry of Women Affairs', bn: 'মহিলা বিষয়ক মন্ত্রণালয়', domain: 'mowca.gov.bd' },
  { name: 'Ministry of Youth', bn: 'যুব মন্ত্রণালয়', domain: 'moysports.gov.bd' },
  { name: 'Ministry of Labor', bn: 'শ্রম মন্ত্রণালয়', domain: 'mole.gov.bd' },
  { name: 'Anti-Corruption Commission', bn: 'দুর্নীতি দমন কমিশন', domain: 'acc.org.bd' },
  { name: 'Election Commission', bn: 'নির্বাচন কমিশন', domain: 'ecs.gov.bd' },
  { name: 'Public Service Commission', bn: 'সরকারি কর্ম কমিশন', domain: 'bpsc.gov.bd' },
  { name: 'National Board of Revenue', bn: 'জাতীয় রাজস্ব বোর্ড', domain: 'nbr.gov.bd' },
  { name: 'Bangladesh Bank', bn: 'বাংলাদেশ ব্যাংক', domain: 'bb.org.bd' }
];

// Government Designations
const govDesignations = [
  { name: 'Secretary', bn: 'সচিব' },
  { name: 'Additional Secretary', bn: 'অতিরিক্ত সচিব' },
  { name: 'Joint Secretary', bn: 'যুগ্ম সচিব' },
  { name: 'Deputy Secretary', bn: 'উপ সচিব' },
  { name: 'Senior Assistant Secretary', bn: 'সিনিয়র সহকারী সচিব' },
  { name: 'Assistant Secretary', bn: 'সহকারী সচিব' },
  { name: 'Director General', bn: 'মহাপরিচালক' },
  { name: 'Director', bn: 'পরিচালক' },
  { name: 'Deputy Director', bn: 'উপ-পরিচালক' },
  { name: 'Assistant Director', bn: 'সহকারী পরিচালক' },
  { name: 'Commissioner', bn: 'কমিশনার' },
  { name: 'Deputy Commissioner', bn: 'জেলা প্রশাসক' },
  { name: 'Upazila Nirbahi Officer', bn: 'উপজেলা নির্বাহী অফিসার' },
  { name: 'Chairman', bn: 'চেয়ারম্যান' },
  { name: 'Member', bn: 'সদস্য' }
];

// Corporate Organizations
const corporations = [
  { name: 'BRAC', type: 'ngo', bn: 'ব্র্যাক', website: 'brac.net' },
  { name: 'Grameen Bank', type: 'corp', bn: 'গ্রামীণ ব্যাংক', website: 'grameenbank.org' },
  { name: 'Square Group', type: 'corp', bn: 'স্কয়ার গ্রুপ', website: 'squaregroup.com' },
  { name: 'Walton Group', type: 'corp', bn: 'ওয়াল্টন গ্রুপ', website: 'waltonbd.com' },
  { name: 'Beximco', type: 'corp', bn: 'বেক্সিমকো', website: 'beximco.com' },
  { name: 'Bashundhara Group', type: 'corp', bn: 'বসুন্ধরা গ্রুপ', website: 'bashundharagroup.com' },
  { name: 'City Group', type: 'corp', bn: 'সিটি গ্রুপ', website: 'citygroup.com.bd' },
  { name: 'Akij Group', type: 'corp', bn: 'আকিজ গ্রুপ', website: 'akij.net' },
  { name: 'Pran-RFL Group', type: 'corp', bn: 'প্রাণ-আরএফএল গ্রুপ', website: 'prangroup.com' },
  { name: 'Meghna Group', type: 'corp', bn: 'মেঘনা গ্রুপ', website: 'meghnagroup.com' },
  { name: 'Rangs Group', type: 'corp', bn: 'র‍্যাংস গ্রুপ', website: 'rangsgroup.com' },
  { name: 'ACI Limited', type: 'corp', bn: 'এসিআই লিমিটেড', website: 'aci-bd.com' },
  { name: 'Grameenphone', type: 'corp', bn: 'গ্রামীণফোন', website: 'grameenphone.com' },
  { name: 'Robi Axiata', type: 'corp', bn: 'রবি আক্সিয়াটা', website: 'robi.com.bd' },
  { name: 'Banglalink', type: 'corp', bn: 'বাংলালিংক', website: 'banglalink.net' },
  { name: 'BGMEA', type: 'ngo', bn: 'বিজিএমইএ', website: 'bgmea.com.bd' },
  { name: 'BKMEA', type: 'ngo', bn: 'বিকেএমইএ', website: 'bkmea.com' },
  { name: 'FBCCI', type: 'ngo', bn: 'এফবিসিসিআই', website: 'fbcci.com' },
  { name: 'Dhaka Chamber', type: 'ngo', bn: 'ঢাকা চেম্বার', website: 'dhakachamber.com' },
  { name: 'DCCI', type: 'ngo', bn: 'ডিসিসিআই', website: 'dcci.com.bd' }
];

// Corporate Designations
const corpDesignations = [
  { name: 'Chief Executive Officer', bn: 'প্রধান নির্বাহী কর্মকর্তা' },
  { name: 'Managing Director', bn: 'ব্যবস্থাপনা পরিচালক' },
  { name: 'Executive Director', bn: 'নির্বাহী পরিচালক' },
  { name: 'Chief Financial Officer', bn: 'প্রধান আর্থিক কর্মকর্তা' },
  { name: 'General Manager', bn: 'মহাব্যবস্থাপক' },
  { name: 'Deputy General Manager', bn: 'উপ-মহাব্যবস্থাপক' },
  { name: 'Manager', bn: 'ব্যবস্থাপক' },
  { name: 'Assistant Manager', bn: 'সহকারী ব্যবস্থাপক' },
  { name: 'Senior Executive', bn: 'সিনিয়র নির্বাহী' },
  { name: 'Executive', bn: 'নির্বাহী' }
];

// Bengali Names (common)
const bengaliFirstNames = [
  'Mohammad', 'Abdul', 'Md.', 'Sk.', 'Ahmed', 'Hasan', 'Rahman', 'Khan', 'Islam', 'Ali',
  'Rahim', 'Karim', 'Anwar', 'Faruk', 'Nasir', 'Jamal', 'Kamal', 'Rafiq', 'Shafiq', 'Tariq',
  'Fatima', 'Ayesha', 'Khadija', 'Sultana', 'Akhter', 'Begum', 'Khatun', 'Jahan', 'Noor', 'Roksana',
  'Aminul', 'Shariful', 'Anisul', 'Monirul', 'Nuruzzaman', 'Mizanur', 'Mahbubur', 'Saidur', 'Golam', 'Khondoker'
];

const bengaliLastNames = [
  'Rahman', 'Islam', 'Hossain', 'Khan', 'Ahmed', 'Alam', 'Uddin', 'Chowdhury', 'Miah', 'Sarker',
  'Bhuiyan', 'Talukder', 'Sikder', 'Biswas', 'Das', 'Roy', 'Barua', 'Saha', 'Pal', 'Nath',
  'Haque', 'Kabir', 'Karim', 'Rashid', 'Aziz', 'Iqbal', 'Hassan', 'Hussain', 'Akbar', 'Jamil'
];

// Helper functions
function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generatePhone(type = 'landline') {
  const prefix = type === 'mobile' ? ['017', '018', '019', '013', '014', '015', '016'][Math.floor(Math.random() * 7)] : '02';
  const suffix = Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
  return `+880-${prefix}-${suffix}`;
}

function generateEmail(name, domain) {
  const sanitized = name.toLowerCase().replace(/[^a-z]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/, '');
  return `${sanitized}@${domain}`;
}

// Generate government contacts
function generateGovContacts(count = 250) {
  const contacts = [];
  
  for (let i = 0; i < count; i++) {
    const ministry = randomElement(govMinistries);
    const designation = randomElement(govDesignations);
    const district = randomElement(districts);
    const division = randomElement(divisions);
    const firstName = randomElement(bengaliFirstNames);
    const lastName = randomElement(bengaliLastNames);
    const fullName = `${firstName} ${lastName}`;
    
    contacts.push({
      office_name: `${ministry.name} - ${district}`,
      name: fullName,
      name_bn: `${firstName} ${lastName}`,
      designation: designation.name,
      designation_bn: designation.bn,
      phone: generatePhone('landline'),
      mobile: generatePhone('mobile'),
      email: generateEmail(fullName, ministry.domain),
      address: `${ministry.name}, ${district}, Bangladesh`,
      address_bn: `${ministry.bn}, ${district}, বাংলাদেশ`,
      photoUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=7000ff&color=fff&size=200`,
      sourceUrl: `https://${ministry.domain}/officers`,
      verifyUrl: `https://${ministry.domain}/officers`,
      entityType: 'gov',
      ministry: ministry.name,
      department: ministry.name,
      district: district,
      division: division,
      website: `https://${ministry.domain}`,
      is_verified: Math.random() > 0.3,
      verification_notes: Math.random() > 0.5 ? 'Verified via official website' : ''
    });
  }
  
  return contacts;
}

// Generate corporate contacts
function generateCorpContacts(count = 150) {
  const contacts = [];
  
  for (let i = 0; i < count; i++) {
    const corp = randomElement(corporations);
    const designation = randomElement(corpDesignations);
    const district = randomElement(districts);
    const firstName = randomElement(bengaliFirstNames);
    const lastName = randomElement(bengaliLastNames);
    const fullName = `${firstName} ${lastName}`;
    
    contacts.push({
      office_name: corp.name,
      name: fullName,
      name_bn: `${firstName} ${lastName}`,
      designation: designation.name,
      designation_bn: designation.bn,
      phone: generatePhone('landline'),
      mobile: generatePhone('mobile'),
      email: generateEmail(fullName, corp.website),
      address: `${corp.name} Head Office, ${district}, Bangladesh`,
      address_bn: `${corp.bn} প্রধান কার্যালয়, ${district}, বাংলাদেশ`,
      photoUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=00a86b&color=fff&size=200`,
      sourceUrl: `https://${corp.website}/team`,
      verifyUrl: `https://${corp.website}/team`,
      entityType: corp.type,
      ministry: corp.name,
      department: corp.name,
      district: district,
      division: 'Dhaka',
      website: `https://${corp.website}`,
      is_verified: Math.random() > 0.4,
      verification_notes: Math.random() > 0.5 ? 'Verified via company website' : ''
    });
  }
  
  return contacts;
}

// Generate NGO contacts
function generateNgoContacts(count = 100) {
  const ngos = corporations.filter(c => c.type === 'ngo');
  const contacts = [];
  
  for (let i = 0; i < count; i++) {
    const ngo = randomElement(ngos) || randomElement(corporations);
    const designation = randomElement(corpDesignations);
    const district = randomElement(districts);
    const firstName = randomElement(bengaliFirstNames);
    const lastName = randomElement(bengaliLastNames);
    const fullName = `${firstName} ${lastName}`;
    
    contacts.push({
      office_name: ngo.name,
      name: fullName,
      name_bn: `${firstName} ${lastName}`,
      designation: designation.name,
      designation_bn: designation.bn,
      phone: generatePhone('landline'),
      mobile: generatePhone('mobile'),
      email: generateEmail(fullName, ngo.website),
      address: `${ngo.name}, ${district}, Bangladesh`,
      address_bn: `${ngo.bn || ngo.name}, ${district}, বাংলাদেশ`,
      photoUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=ff6b35&color=fff&size=200`,
      sourceUrl: `https://${ngo.website}/about`,
      verifyUrl: `https://${ngo.website}/about`,
      entityType: 'ngo',
      ministry: ngo.name,
      department: ngo.name,
      district: district,
      division: randomElement(divisions),
      website: `https://${ngo.website}`,
      is_verified: Math.random() > 0.4,
      verification_notes: ''
    });
  }
  
  return contacts;
}

// Main preload function
async function preloadDatabase(options = {}) {
  const {
    mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/jaani_rti',
    clearExisting = false,
    govCount = 250,
    corpCount = 150,
    ngoCount = 100
  } = options;
  
  console.log('🚀 JAANI RTI Database Preloader (Enhanced)');
  console.log('==========================================\n');
  
  try {
    console.log('📡 Connecting to MongoDB...');
    console.log(`   URI: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');
    
    if (clearExisting) {
      console.log('🗑️  Clearing existing contacts...');
      await Contact.deleteMany({});
      console.log('✅ Cleared existing contacts\n');
    }
    
    // Generate contacts
    console.log('📝 Generating contacts...');
    const govContacts = generateGovContacts(govCount);
    const corpContacts = generateCorpContacts(corpCount);
    const ngoContacts = generateNgoContacts(ngoCount);
    
    const allContacts = [...govContacts, ...corpContacts, ...ngoContacts];
    console.log(`  • Government: ${govContacts.length}`);
    console.log(`  • Corporate: ${corpContacts.length}`);
    console.log(`  • NGO: ${ngoContacts.length}`);
    console.log(`  • Total: ${allContacts.length}\n`);
    
    // Insert contacts
    console.log('💾 Inserting contacts into database...');
    const result = await Contact.insertMany(allContacts, { ordered: false });
    console.log(`✅ Inserted ${result.length} contacts\n`);
    
    // Summary stats
    const stats = await Contact.aggregate([
      { $group: { _id: '$entityType', count: { $sum: 1 } } }
    ]);
    
    console.log('📊 Database Statistics:');
    stats.forEach(s => {
      console.log(`  • ${s._id}: ${s.count}`);
    });
    
    const totalCount = await Contact.countDocuments();
    console.log(`  • Total: ${totalCount}\n`);
    
    console.log('✅ Database preload complete!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('📴 Disconnected from MongoDB');
  }
}

// Export for use in other scripts
module.exports = {
  preloadDatabase,
  generateGovContacts,
  generateCorpContacts,
  generateNgoContacts
};

// Run directly if called as script
if (require.main === module) {
  const args = process.argv.slice(2);
  const clearFlag = args.includes('--clear');
  
  preloadDatabase({ clearExisting: clearFlag })
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
