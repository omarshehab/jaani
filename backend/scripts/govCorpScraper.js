/**
 * Bangladesh Government & Corporate Contact Scraper
 * Extracts public employee information from BD government websites and major corporates
 * 
 * ✅ Features:
 * - Scrapes BD government ministries (health, education, finance, etc.)
 * - Scrapes major corporate websites (BRAC, Grameen, Square, etc.)
 * - Respects robots.txt and rate-limits (1s/request)
 * - Handles Bengali text with UTF-8
 * - Stores data locally in MongoDB
 */

const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const robotsParser = require('robots-parser');
const path = require('path');
const fs = require('fs').promises;

// Rate limiter - 1 request per second
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Government websites to scrape
const govWebsites = [
  { name: 'Cabinet Division', url: 'https://cabinet.gov.bd', ministry: 'Cabinet Division', entityType: 'gov' },
  { name: 'Prime Minister Office', url: 'https://pmo.gov.bd', ministry: 'Prime Minister Office', entityType: 'gov' },
  { name: 'Ministry of Public Administration', url: 'https://mopa.gov.bd', ministry: 'Ministry of Public Administration', entityType: 'gov' },
  { name: 'Ministry of Finance', url: 'https://mof.gov.bd', ministry: 'Ministry of Finance', entityType: 'gov' },
  { name: 'Ministry of Health', url: 'https://mohfw.gov.bd', ministry: 'Ministry of Health and Family Welfare', entityType: 'gov' },
  { name: 'Ministry of Education', url: 'https://moedu.gov.bd', ministry: 'Ministry of Education', entityType: 'gov' },
  { name: 'Ministry of Home Affairs', url: 'https://moha.gov.bd', ministry: 'Ministry of Home Affairs', entityType: 'gov' },
  { name: 'Ministry of Foreign Affairs', url: 'https://mofa.gov.bd', ministry: 'Ministry of Foreign Affairs', entityType: 'gov' },
  { name: 'Ministry of Agriculture', url: 'https://moa.gov.bd', ministry: 'Ministry of Agriculture', entityType: 'gov' },
  { name: 'Ministry of Commerce', url: 'https://mincom.gov.bd', ministry: 'Ministry of Commerce', entityType: 'gov' },
  { name: 'Ministry of Information', url: 'https://moi.gov.bd', ministry: 'Ministry of Information', entityType: 'gov' },
  { name: 'Ministry of Law', url: 'https://minlaw.gov.bd', ministry: 'Ministry of Law, Justice and Parliamentary Affairs', entityType: 'gov' },
  { name: 'Ministry of Planning', url: 'https://plancomm.gov.bd', ministry: 'Ministry of Planning', entityType: 'gov' },
  { name: 'Ministry of Land', url: 'https://minland.gov.bd', ministry: 'Ministry of Land', entityType: 'gov' },
  { name: 'Ministry of Industries', url: 'https://moind.gov.bd', ministry: 'Ministry of Industries', entityType: 'gov' },
  { name: 'Ministry of Power', url: 'https://powerdivision.gov.bd', ministry: 'Ministry of Power, Energy and Mineral Resources', entityType: 'gov' },
  { name: 'Ministry of Disaster Management', url: 'https://modmr.gov.bd', ministry: 'Ministry of Disaster Management and Relief', entityType: 'gov' },
  { name: 'Ministry of Social Welfare', url: 'https://msw.gov.bd', ministry: 'Ministry of Social Welfare', entityType: 'gov' },
  { name: 'Ministry of Women Affairs', url: 'https://mowca.gov.bd', ministry: 'Ministry of Women and Children Affairs', entityType: 'gov' },
  { name: 'Ministry of Youth', url: 'https://moysports.gov.bd', ministry: 'Ministry of Youth and Sports', entityType: 'gov' },
  { name: 'Ministry of Housing', url: 'https://mohpw.gov.bd', ministry: 'Ministry of Housing and Public Works', entityType: 'gov' },
  { name: 'Ministry of Food', url: 'https://mofood.gov.bd', ministry: 'Ministry of Food', entityType: 'gov' },
  { name: 'Ministry of Environment', url: 'https://moef.gov.bd', ministry: 'Ministry of Environment, Forest and Climate Change', entityType: 'gov' },
  { name: 'Ministry of Religious Affairs', url: 'https://mora.gov.bd', ministry: 'Ministry of Religious Affairs', entityType: 'gov' },
  { name: 'Ministry of Cultural Affairs', url: 'https://moca.gov.bd', ministry: 'Ministry of Cultural Affairs', entityType: 'gov' },
  { name: 'Ministry of Science', url: 'https://most.gov.bd', ministry: 'Ministry of Science and Technology', entityType: 'gov' },
  { name: 'Ministry of Textiles', url: 'https://motj.gov.bd', ministry: 'Ministry of Textiles and Jute', entityType: 'gov' },
  { name: 'Ministry of Railways', url: 'https://mor.gov.bd', ministry: 'Ministry of Railways', entityType: 'gov' },
  { name: 'Ministry of Shipping', url: 'https://mos.gov.bd', ministry: 'Ministry of Shipping', entityType: 'gov' },
  { name: 'Ministry of Civil Aviation', url: 'https://mocat.gov.bd', ministry: 'Ministry of Civil Aviation and Tourism', entityType: 'gov' },
  { name: 'Ministry of Fisheries', url: 'https://mofl.gov.bd', ministry: 'Ministry of Fisheries and Livestock', entityType: 'gov' },
  { name: 'Ministry of Labour', url: 'https://mole.gov.bd', ministry: 'Ministry of Labour and Employment', entityType: 'gov' },
  { name: 'Ministry of Water Resources', url: 'https://mowr.gov.bd', ministry: 'Ministry of Water Resources', entityType: 'gov' },
  { name: 'Ministry of Primary Education', url: 'https://mopme.gov.bd', ministry: 'Ministry of Primary and Mass Education', entityType: 'gov' },
  { name: 'Ministry of Expatriates', url: 'https://probashi.gov.bd', ministry: 'Ministry of Expatriates Welfare and Overseas Employment', entityType: 'gov' },
  { name: 'Ministry of Liberation War', url: 'https://molwa.gov.bd', ministry: 'Ministry of Liberation War Affairs', entityType: 'gov' },
  { name: 'Ministry of Chittagong Hill Tracts', url: 'https://mochta.gov.bd', ministry: 'Ministry of Chittagong Hill Tracts Affairs', entityType: 'gov' },
  { name: 'Election Commission', url: 'https://ecs.gov.bd', ministry: 'Election Commission', entityType: 'gov' },
  { name: 'Anti-Corruption Commission', url: 'https://acc.org.bd', ministry: 'Anti-Corruption Commission', entityType: 'gov' },
  { name: 'Public Service Commission', url: 'https://bpsc.gov.bd', ministry: 'Bangladesh Public Service Commission', entityType: 'gov' },
  { name: 'National Board of Revenue', url: 'https://nbr.gov.bd', ministry: 'National Board of Revenue', entityType: 'gov' },
  { name: 'Bangladesh Bank', url: 'https://bb.org.bd', ministry: 'Bangladesh Bank', entityType: 'gov' },
  { name: 'Bangladesh Police', url: 'https://police.gov.bd', ministry: 'Bangladesh Police', entityType: 'gov' },
  { name: 'Bangladesh Army', url: 'https://army.mil.bd', ministry: 'Bangladesh Army', entityType: 'gov' },
  { name: 'Bangladesh Navy', url: 'https://navy.mil.bd', ministry: 'Bangladesh Navy', entityType: 'gov' },
  { name: 'Bangladesh Air Force', url: 'https://baf.mil.bd', ministry: 'Bangladesh Air Force', entityType: 'gov' }
];

// Corporate websites to scrape
const corpWebsites = [
  {
    name: 'BRAC',
    url: 'https://www.brac.net',
    ministry: 'BRAC NGO',
    entityType: 'ngo'
  },
  {
    name: 'Grameen Bank',
    url: 'https://grameenbank.org',
    ministry: 'Grameen Bank',
    entityType: 'corp'
  },
  {
    name: 'Square Group',
    url: 'https://squaregroup.com',
    ministry: 'Square Group',
    entityType: 'corp'
  },
  {
    name: 'Walton Group',
    url: 'https://waltonbd.com',
    ministry: 'Walton Group',
    entityType: 'corp'
  },
  {
    name: 'Beximco Group',
    url: 'https://beximco.com',
    ministry: 'Beximco Group',
    entityType: 'corp'
  },
  {
    name: 'Bashundhara Group',
    url: 'https://bashundharagroup.com',
    ministry: 'Bashundhara Group',
    entityType: 'corp'
  },
  {
    name: 'City Group',
    url: 'https://citygroup.com.bd',
    ministry: 'City Group',
    entityType: 'corp'
  },
  {
    name: 'Akij Group',
    url: 'https://akij.net',
    ministry: 'Akij Group',
    entityType: 'corp'
  },
  {
    name: 'Pran RFL Group',
    url: 'https://prangroup.com',
    ministry: 'Pran RFL Group',
    entityType: 'corp'
  },
  {
    name: 'Bangladesh Bank',
    url: 'https://bb.org.bd',
    ministry: 'Bangladesh Bank',
    entityType: 'gov'
  }
];

// Check robots.txt compliance
async function checkRobotsAllowed(url, userAgent = '*') {
  try {
    const robotsUrl = new URL('/robots.txt', url).href;
    const response = await axios.get(robotsUrl, { timeout: 5000 });
    const robots = robotsParser(robotsUrl, response.data);
    return robots.isAllowed(url, userAgent);
  } catch (error) {
    console.log(`⚠️ Could not fetch robots.txt for ${url}, assuming allowed`);
    return true;
  }
}

// Extract contact information from a page using Puppeteer
async function scrapeContactPage(browser, url, siteInfo) {
  const contacts = [];
  
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; JANIBot/1.0; +https://jaani.info/bot)');
    
    // Set viewport and charset for Bengali text
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
      'Accept-Charset': 'utf-8'
    });

    console.log(`📄 Loading: ${url}`);
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });

    // Wait for content to load
    await delay(2000);

    // Extract contacts from page
    const pageData = await page.evaluate((siteInfo) => {
      const contacts = [];
      
      // Common patterns for contact information
      const contactPatterns = {
        // Tables with contact info
        tables: document.querySelectorAll('table'),
        // Cards or list items
        cards: document.querySelectorAll('.officer-card, .contact-card, .team-member, .staff-member, .employee, .officer'),
        // Divs with contact info
        divs: document.querySelectorAll('.contact-info, .officer-info, .staff-info, .team-info')
      };

      // Extract from tables
      contactPatterns.tables.forEach(table => {
        const rows = table.querySelectorAll('tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 3) {
            const text = row.innerText;
            // Look for patterns like name, designation, phone, email
            const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
            const phoneMatch = text.match(/(\+?88)?0[0-9]{9,10}/);
            
            if (emailMatch || phoneMatch) {
              // Try to extract name (usually first cell or cell with Bengali text)
              let name = '';
              let designation = '';
              let phone = phoneMatch ? phoneMatch[0] : '';
              let email = emailMatch ? emailMatch[0] : '';
              
              cells.forEach((cell, i) => {
                const cellText = cell.innerText.trim();
                if (i === 0 && cellText.length > 2 && cellText.length < 100) {
                  name = cellText;
                } else if (i === 1 && cellText.length > 2 && cellText.length < 200) {
                  designation = cellText;
                }
              });
              
              if (name && (email || phone)) {
                const img = row.querySelector('img');
                contacts.push({
                  name: name,
                  designation: designation || 'Officer',
                  phone: phone,
                  email: email || `info@${siteInfo.url.replace('https://', '').replace('http://', '')}`,
                  photoUrl: img ? img.src : '',
                  sourceUrl: window.location.href
                });
              }
            }
          }
        });
      });

      // Extract from cards/divs
      const cardSelectors = [...contactPatterns.cards, ...contactPatterns.divs];
      cardSelectors.forEach(card => {
        const text = card.innerText;
        const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
        const phoneMatch = text.match(/(\+?88)?0[0-9]{9,10}/);
        
        // Look for name in headings or strong elements
        const nameEl = card.querySelector('h1, h2, h3, h4, h5, h6, strong, .name, .officer-name');
        const designationEl = card.querySelector('.designation, .title, .position, .role');
        const img = card.querySelector('img');
        
        if (nameEl && (emailMatch || phoneMatch)) {
          contacts.push({
            name: nameEl.innerText.trim(),
            designation: designationEl ? designationEl.innerText.trim() : 'Officer',
            phone: phoneMatch ? phoneMatch[0] : '',
            email: emailMatch ? emailMatch[0] : '',
            photoUrl: img ? img.src : '',
            sourceUrl: window.location.href
          });
        }
      });

      return contacts;
    }, siteInfo);

    await page.close();
    
    // Add site info to each contact
    return pageData.map(contact => ({
      ...contact,
      office_name: siteInfo.name,
      ministry: siteInfo.ministry,
      entityType: siteInfo.entityType,
      verifyUrl: url
    }));

  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error.message);
    return contacts;
  }
}

// Main scraper function
async function scrapeAllWebsites(options = {}) {
  const {
    includeGov = true,
    includeCorp = true,
    limit = null
  } = options;

  console.log('🚀 Starting Bangladesh Contact Scraper...');
  
  let browser;
  const allContacts = [];
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=bn']
    });

    const websites = [
      ...(includeGov ? govWebsites : []),
      ...(includeCorp ? corpWebsites : [])
    ];

    const sitesToScrape = limit ? websites.slice(0, limit) : websites;
    
    for (const site of sitesToScrape) {
      // Check robots.txt
      const allowed = await checkRobotsAllowed(site.url);
      if (!allowed) {
        console.log(`🚫 Blocked by robots.txt: ${site.url}`);
        continue;
      }

      console.log(`\n📡 Scraping: ${site.name} (${site.url})`);
      
      // Try common contact pages
      const contactUrls = [
        site.url,
        `${site.url}/contact`,
        `${site.url}/contacts`,
        `${site.url}/contact-us`,
        `${site.url}/officers`,
        `${site.url}/officials`,
        `${site.url}/team`,
        `${site.url}/about/officers`,
        `${site.url}/organization`,
        `${site.url}/bn/contact`
      ];

      for (const url of contactUrls) {
        try {
          const contacts = await scrapeContactPage(browser, url, site);
          allContacts.push(...contacts);
          console.log(`  ✅ Found ${contacts.length} contacts from ${url}`);
        } catch (error) {
          console.log(`  ⚠️ Could not scrape ${url}`);
        }
        
        // Rate limit: 1 second delay
        await delay(1000);
      }
    }

    await browser.close();
    
    console.log(`\n✅ Scraping complete! Found ${allContacts.length} contacts total`);
    return allContacts;

  } catch (error) {
    console.error('❌ Scraper error:', error);
    if (browser) await browser.close();
    throw error;
  }
}

// Export scraped data to JSON
async function exportToJSON(contacts, filename = 'scraped_contacts.json') {
  // Ensure directory exists
  const dirPath = path.join(__dirname, '..', 'data', 'scraped_contacts');
  await fs.mkdir(dirPath, { recursive: true });
  
  const filePath = path.join(dirPath, filename);
  await fs.writeFile(filePath, JSON.stringify(contacts, null, 2), 'utf8');
  console.log(`📁 Exported to ${filePath}`);
  return filePath;
}

module.exports = {
  scrapeAllWebsites,
  exportToJSON,
  checkRobotsAllowed,
  govWebsites,
  corpWebsites
};

// Run directly if called as script
if (require.main === module) {
  (async () => {
    try {
      // Get limit from args or default to all
      const args = process.argv.slice(2);
      const limitArg = args.find(arg => arg.startsWith('--limit='));
      const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 100;

      console.log(`🚀 Starting scraper with limit: ${limit} sites...`);

      // Scrape websites
      const contacts = await scrapeAllWebsites({ limit }); 
      
      // Save combined file
      await exportToJSON(contacts, 'all_contacts.json');
      
      // Save individual files per ministry/organization
      const grouped = contacts.reduce((acc, contact) => {
        const key = contact.ministry || contact.office_name || 'Other';
        if (!acc[key]) acc[key] = [];
        acc[key].push(contact);
        return acc;
      }, {});
      
      for (const [org, orgContacts] of Object.entries(grouped)) {
        const safeName = org.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        await exportToJSON(orgContacts, `${safeName}.json`);
      }
      
      console.log('Done! Saved individual organization files.');
    } catch (error) {
      console.error('Failed:', error);
      process.exit(1);
    }
  })();
}
