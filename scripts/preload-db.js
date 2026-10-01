#!/usr/bin/env node

/**
 * Database Preloader Script for X_Files
 * 
 * This script loads initial contact data into MongoDB for different regions.
 * Usage: node scripts/preload-db.js --region=BD
 */

const mongoose = require('mongoose');
const Contact = require('../backend/models/Contact');
require('dotenv').config();

// Sample contact data for different regions
const sampleContacts = {
  BD: [
    {
      entityType: 'govt',
      name: 'Ministry of Finance BD',
      email: 'info@mof.gov.bd',
      phone: '+880-2-911-1234',
      address: 'Ministry of Finance, Bangladesh Secretariat, Dhaka',
      region: 'BD',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'govt',
      name: 'Ministry of Information BD',
      email: 'info@moi.gov.bd',
      phone: '+880-2-911-2345',
      address: 'Ministry of Information, Bangladesh Secretariat, Dhaka',
      region: 'BD',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'govt',
      name: 'Anti-Corruption Commission BD',
      email: 'info@acc.org.bd',
      phone: '+880-2-911-3456',
      address: 'Anti-Corruption Commission, Dhaka',
      region: 'BD',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'corporate',
      name: 'Grameenphone',
      email: 'info@grameenphone.com',
      phone: '+880-17-12345678',
      address: 'Grameenphone Ltd, Dhaka',
      region: 'BD',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'corporate',
      name: 'Robi Axiata',
      email: 'info@robi.com.bd',
      phone: '+880-18-12345678',
      address: 'Robi Axiata Ltd, Dhaka',
      region: 'BD',
      source: 'DB',
      consent: true,
      verified: true
    }
  ],
  
  US: [
    {
      entityType: 'govt',
      name: 'Department of Justice',
      email: 'contact@doj.gov',
      phone: '+1-202-514-2000',
      address: '950 Pennsylvania Avenue NW, Washington, DC 20530',
      region: 'US',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'govt',
      name: 'Securities and Exchange Commission',
      email: 'help@sec.gov',
      phone: '+1-202-551-6551',
      address: '100 F Street NE, Washington, DC 20549',
      region: 'US',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'corporate',
      name: 'Microsoft Corporation',
      email: 'contact@microsoft.com',
      phone: '+1-425-882-8080',
      address: 'One Microsoft Way, Redmond, WA 98052',
      region: 'US',
      source: 'DB',
      consent: true,
      verified: true
    }
  ],
  
  EU: [
    {
      entityType: 'govt',
      name: 'European Commission',
      email: 'contact@ec.europa.eu',
      phone: '+32-2-299-1111',
      address: 'Rue de la Loi 200, 1049 Brussels, Belgium',
      region: 'EU',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'govt',
      name: 'European Parliament',
      email: 'contact@europarl.europa.eu',
      phone: '+32-2-284-2111',
      address: 'Rue Wiertz 60, 1047 Brussels, Belgium',
      region: 'EU',
      source: 'DB',
      consent: true,
      verified: true
    }
  ],
  
  Global: [
    {
      entityType: 'corporate',
      name: 'Google LLC',
      email: 'contact@google.com',
      phone: '+1-650-253-0000',
      address: '1600 Amphitheatre Parkway, Mountain View, CA 94043',
      region: 'Global',
      source: 'DB',
      consent: true,
      verified: true
    },
    {
      entityType: 'corporate',
      name: 'Apple Inc.',
      email: 'contact@apple.com',
      phone: '+1-408-996-1010',
      address: 'One Apple Park Way, Cupertino, CA 95014',
      region: 'Global',
      source: 'DB',
      consent: true,
      verified: true
    }
  ]
};

async function connectDB() {
  try {
    const mongoURI = process.env.MONGO_URI;
    if (!mongoURI) {
      throw new Error('MONGO_URI environment variable is not defined');
    }

    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
}

async function preloadContacts(region = 'BD') {
  try {
    console.log(`🔄 Preloading contacts for region: ${region}`);
    
    const contacts = sampleContacts[region] || [];
    
    if (contacts.length === 0) {
      console.log(`⚠️  No sample contacts found for region: ${region}`);
      return;
    }

    // Clear existing contacts for the region
    await Contact.deleteMany({ region: region });
    console.log(`🗑️  Cleared existing contacts for region: ${region}`);

    // Insert new contacts
    const insertedContacts = await Contact.insertMany(contacts);
    console.log(`✅ Inserted ${insertedContacts.length} contacts for region: ${region}`);

    // Display inserted contacts
    console.log('\n📋 Inserted contacts:');
    insertedContacts.forEach((contact, index) => {
      console.log(`${index + 1}. ${contact.name} (${contact.entityType})`);
      console.log(`   Email: ${contact.email}`);
      console.log(`   Phone: ${contact.phone}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error preloading contacts:', error);
    throw error;
  }
}

async function preloadAllRegions() {
  try {
    console.log('🌍 Preloading contacts for all regions...');
    
    for (const region of Object.keys(sampleContacts)) {
      await preloadContacts(region);
      console.log(`✅ Completed region: ${region}\n`);
    }

    // Display summary
    const totalContacts = await Contact.countDocuments();
    console.log(`📊 Total contacts in database: ${totalContacts}`);
    
    const regionCounts = {};
    for (const region of Object.keys(sampleContacts)) {
      regionCounts[region] = await Contact.countDocuments({ region });
    }
    
    console.log('\n📈 Contacts by region:');
    Object.entries(regionCounts).forEach(([region, count]) => {
      console.log(`   ${region}: ${count} contacts`);
    });

  } catch (error) {
    console.error('❌ Error preloading all regions:', error);
    throw error;
  }
}

async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const regionArg = args.find(arg => arg.startsWith('--region='));
    const region = regionArg ? regionArg.split('=')[1] : 'BD';
    const allRegions = args.includes('--all');

    console.log('🚀 X_Files Database Preloader');
    console.log('==============================\n');

    await connectDB();

    if (allRegions) {
      await preloadAllRegions();
    } else {
      await preloadContacts(region);
    }

    console.log('\n🎉 Database preloading completed successfully!');
    
  } catch (error) {
    console.error('\n💥 Database preloading failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('📦 Database connection closed');
  }
}

// Handle command line usage
if (require.main === module) {
  main();
}

module.exports = {
  preloadContacts,
  preloadAllRegions,
  sampleContacts
};
