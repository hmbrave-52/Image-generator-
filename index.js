const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint for Render
app.get('/', (req, res) => {
  res.json({ status: 'online', assistant: 'Luna Web Server is ready!' });
});

// Endpoint for Luna to browse/visit a website and read its content
app.post('/api/browse', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required in the request body.' });
  }

  let browser;
  try {
    // Launch headless browser with flags optimized for cloud servers like Render
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    // Set a realistic User-Agent so websites don't block the request
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Go to the target URL with a timeout
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Extract title and text content for Luna to analyze
    const pageData = await page.evaluate(() => {
      return {
        title: document.title,
        text: document.body.innerText.substring(0, 8000), // Limit text size to keep responses fast
        url: window.location.href
      };
    });

    await browser.close();
    res.json({ success: true, data: pageData });

  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    console.error('Browsing error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Luna server is running on port ${PORT}`);
});
      
