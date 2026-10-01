/**
 * JANI - Bangladesh Government Directory Scraper
 * ===============================================
 * Scrapes officer information from Bangladesh Government portal
 * 
 * Sources:
 * - http://www.bangladesh.gov.bd/site/view/officer_list
 * - http://cabinet.portal.gov.bd/
 * - Ministry-specific portals
 * 
 * Extracts:
 * - Name (Bengali & English)
 * - Designation
 * - Ministry/Department
 * - Email
 * - Phone
 * - Office Address
 * 
 * Usage:
 *   node scrape_bd_gov.js
 *   node scrape_bd_gov.js --ministry "তথ্য মন্ত্রণালয়"
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
  outputDir: path.join(__dirname, '../data'),
  outputFile: 'gov_contacts.json',
  maxRetries: 3,
  pageTimeout: 60000,
  delayBetweenRequests: 2000, // Be respectful to government servers
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  
  // Bangladesh Government Portal URLs
  sources: [
    {
      name: 'National Portal - Officer List',
      url: 'http://www.bangladesh.gov.bd/site/view/officer_list',
      type: 'officer_list'
    },
    {
      name: 'Cabinet Division',
      url: 'http://cabinet.portal.gov.bd/',
      type: 'ministry'
    }
  ],
  
  // Ministry portal patterns
  ministryPatterns: [
    { name: 'মন্ত্রিপরিষদ বিভাগ', url: 'http://cabinet.gov.bd', englishName: 'Cabinet Division' },
    { name: 'জনপ্রশাসন মন্ত্রণালয়', url: 'http://mopa.gov.bd', englishName: 'Ministry of Public Administration' },
    { name: 'তথ্য ও সম্প্রচার মন্ত্রণালয়', url: 'http://moi.gov.bd', englishName: 'Ministry of Information' },
    { name: 'স্বরাষ্ট্র মন্ত্রণালয়', url: 'http://moha.gov.bd', englishName: 'Ministry of Home Affairs' },
    { name: 'অর্থ মন্ত্রণালয়', url: 'http://mof.gov.bd', englishName: 'Ministry of Finance' },
    { name: 'পররাষ্ট্র মন্ত্রণালয়', url: 'http://mofa.gov.bd', englishName: 'Ministry of Foreign Affairs' },
    { name: 'আইন বিচার ও সংসদ বিষয়ক মন্ত্রণালয়', url: 'http://minlaw.gov.bd', englishName: 'Ministry of Law, Justice and Parliamentary Affairs' },
    { name: 'শিক্ষা মন্ত্রণালয়', url: 'http://moedu.gov.bd', englishName: 'Ministry of Education' },
    { name: 'স্বাস্থ্য ও পরিবার কল্যাণ মন্ত্রণালয়', url: 'http://mohfw.gov.bd', englishName: 'Ministry of Health and Family Welfare' },
    { name: 'কৃষি মন্ত্রণালয়', url: 'http://moa.gov.bd', englishName: 'Ministry of Agriculture' },
  ]
};

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sanitizeText = (text) => {
  if (!text) return '';
  return text.trim()
    .replace(/\s+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
};

const extractEmail = (text) => {
  if (!text) return null;
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return emailMatch ? emailMatch[0].toLowerCase() : null;
};

const extractPhone = (text) => {
  if (!text) return null;
  // Bangladesh phone patterns: +880, 01XXX, 02-XXXX
  const phoneMatch = text.match(/(?:\+?880|0)?1[3-9]\d{8}|(?:\+?880-?)?2-?\d{7,8}/);
  return phoneMatch ? phoneMatch[0] : null;
};

/**
 * Main Scraper Class
 */
class BDGovScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.contacts = [];
    this.errors = [];
  }

  async initialize() {
    console.log('🚀 Initializing browser...');
    
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(CONFIG.userAgent);
    await this.page.setViewport({ width: 1920, height: 1080 });
    
    // Set longer timeout for government sites
    this.page.setDefaultNavigationTimeout(CONFIG.pageTimeout);
    this.page.setDefaultTimeout(CONFIG.pageTimeout);

    console.log('✅ Browser initialized');
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('🔒 Browser closed');
    }
  }

  /**
   * Scrape National Portal Officer List
   */
  async scrapeNationalPortal() {
    const url = 'http://www.bangladesh.gov.bd/site/view/officer_list';
    console.log(`\n📋 Scraping National Portal: ${url}`);

    try {
      await this.page.goto(url, { waitUntil: 'networkidle2' });
      await sleep(2000);

      // Try to find officer table or list
      const officers = await this.page.evaluate(() => {
        const results = [];
        
        // Common patterns on gov.bd portals
        const selectors = [
          'table.officer-list tr',
          '.officer-info',
          '.contact-box',
          '.personnel-list li',
          'table tbody tr',
          '.card.officer'
        ];

        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            elements.forEach(el => {
              const name = el.querySelector('.name, .officer-name, h3, h4, td:first-child')?.textContent;
              const designation = el.querySelector('.designation, .title, .position, td:nth-child(2)')?.textContent;
              const email = el.querySelector('a[href^="mailto:"], .email')?.textContent || 
                           el.textContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
              const phone = el.querySelector('.phone, .mobile, .tel')?.textContent ||
                           el.textContent.match(/(?:\+?880|0)?1[3-9]\d{8}/)?.[0];
              const ministry = el.querySelector('.ministry, .department, .organization')?.textContent;

              if (name) {
                results.push({
                  name: name?.trim(),
                  designation: designation?.trim(),
                  email: email?.trim()?.toLowerCase(),
                  phone: phone?.trim(),
                  ministry: ministry?.trim(),
                  source: window.location.href
                });
              }
            });
            break;
          }
        }

        return results;
      });

      console.log(`   Found ${officers.length} officers from National Portal`);
      this.contacts.push(...officers.filter(o => o.name));

    } catch (error) {
      console.error(`   ❌ Error scraping National Portal: ${error.message}`);
      this.errors.push({ source: url, error: error.message });
    }
  }

  /**
   * Scrape Ministry-specific portal
   */
  async scrapeMinistryPortal(ministry) {
    console.log(`\n🏛️  Scraping: ${ministry.englishName}`);
    console.log(`   URL: ${ministry.url}`);

    const officerListUrls = [
      `${ministry.url}/site/view/officer_list`,
      `${ministry.url}/site/page/officer`,
      `${ministry.url}/site/page/contact`,
      `${ministry.url}/bn/site/view/officer_list`,
      ministry.url
    ];

    for (const url of officerListUrls) {
      try {
        await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(1500);

        const officers = await this.page.evaluate((ministryName, ministryEnglish) => {
          const results = [];
          
          // Look for officer/contact sections
          const containers = document.querySelectorAll(
            '.officer-list, .contact-list, .personnel, table, .card-deck, .row'
          );

          containers.forEach(container => {
            // Find individual officer blocks
            const officerBlocks = container.querySelectorAll(
              'tr, .officer, .contact-card, .card, .col-md-4, .col-md-6, li'
            );

            officerBlocks.forEach(block => {
              const text = block.textContent;
              
              // Skip if too short or navigation element
              if (text.length < 20 || block.closest('nav, header, footer')) return;

              // Extract structured data
              const nameEl = block.querySelector('h3, h4, h5, .name, .officer-name, strong, b, td:first-child');
              const designationEl = block.querySelector('.designation, .position, .title, small, td:nth-child(2)');
              const emailEl = block.querySelector('a[href^="mailto:"]');
              const phoneEl = block.querySelector('.phone, .mobile, a[href^="tel:"]');

              let name = nameEl?.textContent?.trim();
              let designation = designationEl?.textContent?.trim();
              let email = emailEl?.href?.replace('mailto:', '')?.trim() || 
                         text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
              let phone = phoneEl?.href?.replace('tel:', '')?.trim() ||
                         text.match(/(?:\+?880|0)?1[3-9]\d{8}/)?.[0];

              // Only add if we have a name
              if (name && name.length > 2 && name.length < 100) {
                results.push({
                  name,
                  designation: designation || null,
                  email: email?.toLowerCase() || null,
                  phone: phone || null,
                  ministry: ministryName,
                  ministryEnglish: ministryEnglish,
                  source: window.location.href
                });
              }
            });
          });

          return results;
        }, ministry.name, ministry.englishName);

        if (officers.length > 0) {
          console.log(`   ✅ Found ${officers.length} officers`);
          this.contacts.push(...officers);
          break; // Found data, no need to try other URLs
        }

      } catch (error) {
        // Continue to next URL pattern
      }
    }

    await sleep(CONFIG.delayBetweenRequests);
  }

  /**
   * Scrape a generic directory URL (used with discovered candidate URLs)
   */
  async scrapeDirectoryUrl(url, ministryHint = null) {
    console.log(`\n📌 Scraping discovered directory URL: ${url}`);
    try {
      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(1500);

      const officers = await this.page.evaluate((ministryName) => {
        const results = [];

        // Try common containers
        const containers = document.querySelectorAll(
          'article, main, .content, .container, .officer-list, .contact-list, .personnel, table, .card-deck, .row'
        );

        const extractFromBlock = (block) => {
          const text = block.textContent || '';
          if (text.length < 20) return;
          if (block.closest('nav, header, footer')) return;

          const nameEl = block.querySelector('h3, h4, h5, .name, .officer-name, strong, b, td:first-child');
          const designationEl = block.querySelector('.designation, .position, .title, small, td:nth-child(2)');
          const emailEl = block.querySelector('a[href^="mailto:"]');
          const phoneEl = block.querySelector('.phone, .mobile, a[href^="tel:"]');

          let name = nameEl?.textContent?.trim();
          let designation = designationEl?.textContent?.trim();
          let email = emailEl?.href?.replace('mailto:', '')?.trim() ||
            text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
          let phone = phoneEl?.href?.replace('tel:', '')?.trim() ||
            text.match(/(?:\+?880|0)?1[3-9]\d{8}|(?:\+?880-?)?2-?\d{7,8}/)?.[0];

          if (name && name.length > 2 && name.length < 120) {
            results.push({
              name,
              designation: designation || null,
              email: email?.toLowerCase() || null,
              phone: phone || null,
              ministry: ministryName || null,
              source: window.location.href
            });
          }
        };

        containers.forEach(container => {
          const blocks = container.querySelectorAll('tr, .officer, .contact-card, .card, .col-md-4, .col-md-6, li, .row > div');
          blocks.forEach(extractFromBlock);
        });

        return results;
      }, ministryHint);

      if (officers && officers.length > 0) {
        console.log(`   ✅ Found ${officers.length} contacts`);
        this.contacts.push(...officers);
      } else {
        console.log('   ⚠️  No contacts found on this page');
      }
    } catch (error) {
      console.log(`   ❌ Failed to scrape URL: ${error.message}`);
      this.errors.push({ source: url, error: error.message });
    }

    await sleep(CONFIG.delayBetweenRequests);
  }

  /**
   * Load existing scraped contacts and merge
   */
  async loadExistingContacts() {
    const scrapedDir = path.join(CONFIG.outputDir, 'scraped_contacts');
    
    try {
      const files = await fs.readdir(scrapedDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      console.log(`\n📂 Loading ${jsonFiles.length} existing contact files...`);

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(scrapedDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);

          // Handle different data formats
          let contacts = [];
          if (Array.isArray(data)) {
            contacts = data;
          } else if (data.officers) {
            contacts = data.officers;
          } else if (data.contacts) {
            contacts = data.contacts;
          }

          // Normalize contact structure
          contacts.forEach(c => {
            this.contacts.push({
              name: c.name || c.নাম || c.officer_name,
              nameBengali: c.nameBengali || c.নাম,
              nameEnglish: c.nameEnglish || c.name_english,
              designation: c.designation || c.পদবী || c.title,
              ministry: c.ministry || c.মন্ত্রণালয় || file.replace('.json', '').replace(/_/g, ' '),
              email: c.email || c.ইমেইল,
              phone: c.phone || c.ফোন || c.mobile,
              address: c.address || c.ঠিকানা,
              source: c.source || `scraped_contacts/${file}`,
              scrapedAt: c.scrapedAt || new Date().toISOString()
            });
          });

          console.log(`   ✅ Loaded ${contacts.length} contacts from ${file}`);
        } catch (error) {
          console.log(`   ⚠️  Could not parse ${file}: ${error.message}`);
        }
      }
    } catch (error) {
      console.log('   ℹ️  No existing scraped_contacts directory found');
    }
  }

  /**
   * Deduplicate contacts
   */
  deduplicateContacts() {
    console.log(`\n🔄 Deduplicating ${this.contacts.length} contacts...`);

    const seen = new Map();
    const unique = [];

    for (const contact of this.contacts) {
      if (!contact.name) continue;

      // Create a key based on name + ministry (or just name if no ministry)
      const key = `${contact.name}|${contact.ministry || ''}`.toLowerCase();

      if (!seen.has(key)) {
        seen.set(key, true);
        unique.push(contact);
      } else {
        // Merge data if we find a duplicate
        const existing = unique.find(c => 
          `${c.name}|${c.ministry || ''}`.toLowerCase() === key
        );
        if (existing) {
          // Fill in missing fields
          if (!existing.email && contact.email) existing.email = contact.email;
          if (!existing.phone && contact.phone) existing.phone = contact.phone;
          if (!existing.designation && contact.designation) existing.designation = contact.designation;
        }
      }
    }

    this.contacts = unique;
    console.log(`   ✅ Reduced to ${this.contacts.length} unique contacts`);
  }

  /**
   * Save contacts to JSON file
   */
  async saveContacts() {
    // Ensure output directory exists
    await fs.mkdir(CONFIG.outputDir, { recursive: true });

    const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);
    
    const output = {
      metadata: {
        scrapedAt: new Date().toISOString(),
        totalContacts: this.contacts.length,
        sources: [...new Set(this.contacts.map(c => c.source))],
        errors: this.errors
      },
      contacts: this.contacts
    };

    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n💾 Saved ${this.contacts.length} contacts to ${outputPath}`);

    // Also save a compact version for quick loading
    const compactPath = path.join(CONFIG.outputDir, 'gov_contacts_compact.json');
    const compact = this.contacts.map(c => ({
      n: c.name,
      d: c.designation,
      m: c.ministry,
      e: c.email,
      p: c.phone
    }));
    await fs.writeFile(compactPath, JSON.stringify(compact), 'utf-8');
    console.log(`💾 Saved compact version to ${compactPath}`);

    return outputPath;
  }

  /**
   * Main scraping workflow
   */
  async run() {
    console.log('═'.repeat(80));
    console.log('🇧🇩 JANI - Bangladesh Government Directory Scraper');
    console.log('═'.repeat(80));

    try {
      // Load existing contacts first
      await this.loadExistingContacts();

      // Initialize browser for live scraping
      await this.initialize();

      // Scrape National Portal
      await this.scrapeNationalPortal();

      // Scrape Ministry portals
      for (const ministry of CONFIG.ministryPatterns) {
        await this.scrapeMinistryPortal(ministry);
      }

      // Optional: scrape discovered candidate URLs
      const inputIdx = process.argv.indexOf('--input');
      if (inputIdx !== -1 && process.argv[inputIdx + 1]) {
        const inputPath = process.argv[inputIdx + 1];
        try {
          const raw = await fs.readFile(inputPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const urls = Array.isArray(parsed) ? parsed : (parsed.candidates || []);
          console.log(`\n🧭 Scraping discovered URLs from: ${inputPath} (${urls.length} urls)`);
          for (const u of urls.slice(0, 300)) {
            await this.scrapeDirectoryUrl(u);
          }
        } catch (e) {
          console.log(`⚠️  Could not read --input file: ${e.message}`);
        }
      }

      // Close browser
      await this.close();

      // Deduplicate
      this.deduplicateContacts();

      // Save results
      const outputPath = await this.saveContacts();

      // Summary
      console.log('\n' + '═'.repeat(80));
      console.log('📊 SCRAPING SUMMARY');
      console.log('═'.repeat(80));
      console.log(`   Total contacts: ${this.contacts.length}`);
      console.log(`   With email: ${this.contacts.filter(c => c.email).length}`);
      console.log(`   With phone: ${this.contacts.filter(c => c.phone).length}`);
      console.log(`   Unique ministries: ${new Set(this.contacts.map(c => c.ministry)).size}`);
      console.log(`   Errors: ${this.errors.length}`);
      console.log(`   Output: ${outputPath}`);
      console.log('═'.repeat(80));

      return this.contacts;

    } catch (error) {
      console.error('\n❌ Fatal error:', error);
      await this.close();
      throw error;
    }
  }
}

// CLI execution
if (require.main === module) {
  const scraper = new BDGovScraper();
  
  scraper.run()
    .then(() => {
      console.log('\n✅ Scraping completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Scraping failed:', error);
      process.exit(1);
    });
}

module.exports = { BDGovScraper, CONFIG };
